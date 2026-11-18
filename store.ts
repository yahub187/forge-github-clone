// The forge's in-memory store: git objects, repositories, issues and pull
// requests in one place, shared by the REST, git, GraphQL and MCP surfaces.
// Everything is deterministic: ids come from counters, timestamps derive from
// a fixed epoch plus a sequence number, and no wall clock or randomness ever
// reaches stored state.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const FIXED_EPOCH_SEC = 1_735_689_600;
export const COMMITTER_IDENTITY = 'Forge <forge@example.invalid>';

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function isoOf(seq: number): string {
  return new Date((FIXED_EPOCH_SEC + seq) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------------------
// git object parsing and building

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export function parseTagTarget(data: Buffer): string {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : ZERO_OID;
}

export function buildCommitData(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  timestampSec: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  const stamp = `${fields.timestampSec} +0000`;
  lines.push(`author ${COMMITTER_IDENTITY} ${stamp}`);
  lines.push(`committer ${COMMITTER_IDENTITY} ${stamp}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// domain records

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergeCommitSha: string | null;
  seq: number;
}

export class Repo {
  readonly id: number;
  owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly objects = new Map<string, GitObj>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextIssueNumber = 1;
  nextPullNumber = 1;
  commitSeq = 0;
  readonly seq: number;

  constructor(id: number, seq: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.id = id;
    this.seq = seq;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  commitView(oid: string): CommitView | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Peel a commit/tag oid to the commit it ultimately names, or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const obj = this.objects.get(current);
      if (!obj) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTagTarget(obj.data);
        continue;
      }
      return null;
    }
    return null;
  }

  /** The peeled commit for any ref target (tag objects peel to their commit). */
  peeled(oid: string): string | null {
    const obj = this.objects.get(oid);
    if (!obj) return null;
    if (obj.type === 'tag') return this.peelToCommit(oid);
    return null;
  }

  refTip(ref: string): string | null {
    return this.refs.get(ref) ?? null;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Flatten a tree (recursively) into path -> blob oid. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') this.flattenTree(entry.oid, path, out);
      else out.set(path, entry.oid);
    }
    return out;
  }

  filesAtCommit(commitOid: string): Map<string, string> {
    const view = this.commitView(commitOid);
    if (!view) return new Map();
    return this.flattenTree(view.tree);
  }

  /** Build (and store) a tree from a flat path -> blob oid map; returns its oid. */
  treeFromFiles(files: ReadonlyMap<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i];
        if (!node.dirs.has(seg)) node.dirs.set(seg, make());
        node = node.dirs.get(seg) as Node;
      }
      node.files.set(segments[segments.length - 1], oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on top of the given parents; returns its oid. */
  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    this.commitSeq += 1;
    const data = buildCommitData({
      tree: treeOid,
      parents,
      message,
      timestampSec: FIXED_EPOCH_SEC + this.commitSeq,
    });
    return this.putObject('commit', data);
  }

  /** All commit oids reachable from a tip (the tip included), breadth-first. */
  ancestorsOf(tip: string): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      const commit = this.peelToCommit(current);
      if (commit === null) continue;
      if (seen.has(commit)) continue;
      seen.add(commit);
      const view = this.commitView(commit);
      if (view) for (const parent of view.parents) queue.push(parent);
    }
    return seen;
  }

  isAncestor(maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    return this.ancestorsOf(tip).has(maybeAncestor);
  }

  /** A common ancestor of two commits (the deepest one found), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = this.ancestorsOf(a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsA.has(current)) return current;
      const view = this.commitView(current);
      if (view) for (const parent of view.parents) queue.push(parent);
    }
    return null;
  }

  /** Ordered commit list from a tip: tip first, then ancestors breadth-first. */
  historyFrom(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      const view = this.commitView(current);
      if (!view) continue;
      seen.add(current);
      order.push(current);
      for (const parent of view.parents) queue.push(parent);
    }
    return order;
  }
}

// ---------------------------------------------------------------------------
// the store itself

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  baseOid: string | null;
  headOid: string | null;
}

/** Compare the file maps of two commits (base -> head). */
export function diffFiles(repo: Repo, baseCommit: string | null, headCommit: string | null): FileChange[] {
  const baseFiles = baseCommit ? repo.filesAtCommit(baseCommit) : new Map<string, string>();
  const headFiles = headCommit ? repo.filesAtCommit(headCommit) : new Map<string, string>();
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path) ?? null;
    const headOid = headFiles.get(path) ?? null;
    if (baseOid === headOid) continue;
    changes.push({
      path,
      status: baseOid === null ? 'added' : headOid === null ? 'removed' : 'modified',
      baseOid,
      headOid,
    });
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  sha: string | null;
  conflict: boolean;
}

/**
 * Squash-merge a pull request into its base branch: the changes the head made
 * relative to the merge base are applied onto the current base tip. A path
 * both sides changed differently since the merge base is a conflict.
 */
export function squashMerge(repo: Repo, pull: Pull): MergeOutcome {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, sha: null, conflict: true };
  const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const fromBase = diffFiles(repo, base, baseTip);
  const fromHead = diffFiles(repo, base, headTip);
  const baseChanged = new Map(fromBase.map((change) => [change.path, change.headOid]));
  const mergedFiles = repo.filesAtCommit(baseTip);
  for (const change of fromHead) {
    if (baseChanged.has(change.path)) {
      const baseResult = baseChanged.get(change.path) ?? null;
      if (baseResult !== change.headOid) return { ok: false, sha: null, conflict: true };
      continue;
    }
    if (change.headOid === null) mergedFiles.delete(change.path);
    else mergedFiles.set(change.path, change.headOid);
  }
  const tree = repo.treeFromFiles(mergedFiles);
  const sha = repo.makeCommit(tree, [baseTip], `${pull.title}\n\nSquash merge of pull request #${pull.number}`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return { ok: true, sha, conflict: false };
}

/** Whether merging this pull would conflict (same test as squashMerge). */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return true;
  const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const fromBase = diffFiles(repo, base, baseTip);
  const fromHead = diffFiles(repo, base, headTip);
  const baseChanged = new Map(fromBase.map((change) => [change.path, change.headOid]));
  for (const change of fromHead) {
    if (baseChanged.has(change.path) && (baseChanged.get(change.path) ?? null) !== change.headOid) return true;
  }
  return false;
}

// Relay-style global ids: base64 of "<Type>:<repoId>:<number>".
export function globalId(kind: string, repoId: number, number = 0): string {
  return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
    return { kind: parts[0], repoId, number };
  } catch {
    return null;
  }
}

export class Store {
  readonly reposByName = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  learnedOwner: string | null = null;
  private repoCounter = 0;
  private issueIdCounter = 0;
  private commentIdCounter = 0;
  private pullIdCounter = 0;
  private labelIdCounter = 0;
  private seqCounter = 0;

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo | null {
    if (this.reposByName.has(name)) return null;
    this.repoCounter += 1;
    const repo = new Repo(this.repoCounter, this.nextSeq(), owner, name, description, isPrivate, defaultBranch || 'main');
    this.reposByName.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /**
   * Resolve a repository addressed as owner/name. A repository created through
   * /user/repos belongs to the token owner; the first owner that addresses it
   * by name claims it, and any other owner is a 404.
   */
  claimRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    if (repo.owner === '') {
      repo.owner = owner;
      if (this.learnedOwner === null) this.learnedOwner = owner;
      return repo;
    }
    if (repo.owner !== owner) return null;
    if (this.learnedOwner === null) this.learnedOwner = owner;
    return repo;
  }

  repoByName(name: string): Repo | null {
    return this.reposByName.get(name) ?? null;
  }

  viewerLogin(): string | null {
    if (this.learnedOwner !== null) return this.learnedOwner;
    for (const repo of this.reposByName.values()) if (repo.owner !== '') return repo.owner;
    return null;
  }

  nextIssueId(): number {
    this.issueIdCounter += 1;
    return this.issueIdCounter;
  }

  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }

  nextPullId(): number {
    this.pullIdCounter += 1;
    return this.pullIdCounter;
  }

  nextLabelId(): number {
    this.labelIdCounter += 1;
    return this.labelIdCounter;
  }
}
