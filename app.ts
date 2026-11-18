// The forge's HTTP surface: git smart HTTP, the REST v3 API, GraphQL v4 and
// the MCP endpoint, all served from the one in-memory store in store.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Store,
  ZERO_OID,
  diffFiles,
  globalId,
  decodeGlobalId,
  isoOf,
  pullConflicts,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  PKT_FLUSH,
  collectObjects,
  fetchObjectSet,
  parsePacketStream,
  pktLine,
  readPack,
  writePack,
  type Packet,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_ISO = isoOf(0);

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function requiresAuth(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** The bearer token this process was given, when the harness set one. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries an acceptable Authorization header. */
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected !== '') return presented === expected;
  return true;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------------------
// serializers

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(repo.seq),
    updated_at: isoOf(repo.seq),
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', default: false, description: null };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: repo.owner, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.seq),
    updated_at: isoOf(issue.seq),
    closed_at: issue.state === 'closed' ? isoOf(issue.seq) : null,
  };
}

function commentJson(repo: Repo, comment: { id: number; body: string; seq: number }): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, comment.id),
    body: comment.body,
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: isoOf(comment.seq),
    updated_at: isoOf(comment.seq),
  };
}

function pullJson(repo: Repo, pull: Pull): Json {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged ? FIXED_ISO : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: isoOf(pull.seq),
    updated_at: isoOf(pull.seq),
  };
}

// ---------------------------------------------------------------------------
// shared record operations

function commitFileChange(repo: Repo, branch: string, path: string, blobOid: string | null, message: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const files = tip !== null ? repo.filesAtCommit(tip) : new Map<string, string>();
  if (blobOid === null) files.delete(path);
  else files.set(path, blobOid);
  const tree = repo.treeFromFiles(files);
  const commit = repo.makeCommit(tree, tip !== null ? [tip] : [], message);
  repo.refs.set(ref, commit);
  return commit;
}

function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    number: repo.nextIssueNumber,
    id: store.nextIssueId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq(),
  };
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullRecord(store: Store, repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
  const pull: Pull = {
    number: repo.nextPullNumber,
    id: store.nextPullId(),
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headShaAtCreate: repo.branchTip(input.head) ?? ZERO_OID,
    baseShaAtCreate: repo.branchTip(input.base) ?? ZERO_OID,
    merged: false,
    mergeCommitSha: null,
    seq: store.nextSeq(),
  };
  repo.nextPullNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Merge a pull request (squash). Returns the merge commit sha, or null on conflict. */
function mergePullRecord(repo: Repo, pull: Pull): string | null {
  const outcome = squashMerge(repo, pull);
  if (!outcome.ok || outcome.sha === null) return null;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = outcome.sha;
  return outcome.sha;
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function pageSlice<T>(url: URL, items: readonly T[], origin: string): { slice: T[]; link: string | null } {
  const { perPage, page } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(`${url.pathname}${url.search}`, origin);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(`${url.pathname}${url.search}`, origin);
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    last.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { slice, link };
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? `http://${host}` : 'http://entry';
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

// ---------------------------------------------------------------------------
// REST v3

async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';
  if (!authed(req)) {
    requiresAuth(res);
    return;
  }
  // Parse a JSON body when one is present; a malformed body is a 400.
  let body: Json = {};
  let rawBody = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    rawBody = await readBody(req);
    if (rawBody.length > 0) {
      try {
        const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
        body = asRecord(parsed) ?? {};
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
  }
  const segments = url.pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));

  // API root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', hooks: [], git: {}, pages: {}, importer: {}, actions: {}, dependabot: {} });
    return;
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    const login = store.viewerLogin();
    if (login === null) {
      notFound(res);
      return;
    }
    sendJson(res, 200, { login, id: 1000, type: 'User', name: login });
    return;
  }

  // The viewer's repositories: list and create.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.reposByName.values()].sort((a, b) => a.id - b.id).map(repoJson);
      const { slice, link } = pageSlice(url, all, originOf(req));
      sendJson(res, 200, slice, link !== null ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (name === '') {
        sendJson(res, 422, { message: 'Repository creation failed: name is required' });
        return;
      }
      const existing = store.repoByName(name);
      if (existing !== null) {
        sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' });
        return;
      }
      const owner = store.viewerLogin() ?? '';
      const repo = store.createRepo(
        owner,
        name,
        strOr(body.description, ''),
        body.private === undefined ? false : body.private === true,
        strOr(body.default_branch, 'main'),
      );
      if (repo === null) {
        sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' });
        return;
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }
  const owner = segments[1];
  const repoName = segments[2];
  const rest = segments.slice(3);
  const repo = store.claimRepo(owner, repoName);
  if (repo === null) {
    notFound(res);
    return;
  }
  await handleRepoRest(store, req, res, url, repo, rest, method, body);
}

async function handleRepoRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  rest: string[],
  method: string,
  body: Json,
): Promise<void> {
  const origin = originOf(req);
  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '') {
        // Renames are accepted but the store keys by the original name.
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.reposByName.delete(repo.name);
      store.reposById.delete(repo.id);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  // Branches.
  if (rest[0] === 'branches' && method === 'GET') {
    if (rest.length === 1) {
      const branches: Json[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false });
      }
      sendJson(res, 200, branches);
      return;
    }
    const branch = rest.slice(1).join('/');
    const sha = repo.branchTip(branch);
    if (sha === null) {
      notFound(res);
      return;
    }
    sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
    return;
  }

  // Commits.
  if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
    const shaParam = url.searchParams.get('sha');
    let tip: string | null = null;
    if (shaParam === null || shaParam === '') tip = repo.branchTip(repo.defaultBranch);
    else if (repo.refs.has(`refs/heads/${shaParam}`)) tip = repo.branchTip(shaParam);
    else if (/^[0-9a-f]{40}$/.test(shaParam) && repo.getObject(shaParam)?.type === 'commit') tip = shaParam;
    else if (repo.refs.has(shaParam)) tip = repo.refs.get(shaParam) ?? null;
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const commits = repo.historyFrom(tip).map((sha) => {
      const view = repo.commitView(sha);
      return {
        sha,
        node_id: globalId('Commit', repo.id, 0) + sha.slice(0, 8),
        commit: {
          message: view?.message ?? '',
          tree: { sha: view?.tree ?? ZERO_OID },
          author: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_ISO },
          committer: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_ISO },
        },
        parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    sendJson(res, 200, commits);
    return;
  }

  // Git refs (the Git Data API).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.getObject(sha)) {
        sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: globalId('Ref', repo.id, 0), object: { type: repo.getObject(sha)?.type ?? 'commit', sha } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref, object: { type: repo.getObject(sha)?.type ?? 'commit', sha } });
      return;
    }
    notFound(res);
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      getContent(res, url, repo, path);
      return;
    }
    if (method === 'PUT') {
      putContent(res, repo, path, body);
      return;
    }
    if (method === 'DELETE') {
      deleteContent(res, repo, path, body);
      return;
    }
    notFound(res);
    return;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = str(body.name);
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (!repo.labels.has(name)) {
        repo.labels.set(name, { id: store.nextLabelId(), name, color: strOr(body.color, 'ededed') });
      }
      sendJson(res, 201, labelJson(repo, name));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
      return;
    }
    notFound(res);
    return;
  }

  // Issues and comments.
  if (rest[0] === 'issues') {
    handleIssues(store, res, url, repo, rest.slice(1), method, body, origin);
    return;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    handlePulls(store, res, url, repo, rest.slice(1), method, body, origin);
    return;
  }

  notFound(res);
}

function resolveCommitRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.branchTip(repo.defaultBranch);
  const branchTip = repo.branchTip(ref);
  if (branchTip !== null) return branchTip;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.getObject(ref)?.type === 'commit') return ref;
  return null;
}

function getContent(res: ServerResponse, url: URL, repo: Repo, path: string): void {
  const commit = resolveCommitRef(repo, url.searchParams.get('ref'));
  if (commit === null) {
    notFound(res);
    return;
  }
  const view = repo.commitView(commit);
  if (!view) {
    notFound(res);
    return;
  }
  // Walk the tree to the requested path.
  let treeOid = view.tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const treeObj = repo.getObject(treeOid);
    if (!treeObj || treeObj.type !== 'tree') {
      notFound(res);
      return;
    }
    const entries = parseTreeOf(repo, treeOid);
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (!entry) {
      notFound(res);
      return;
    }
    if (i === segments.length - 1) {
      if (entry.mode === '40000' || entry.mode === '040000') {
        sendJson(res, 200, dirListing(repo, entry.oid, path));
        return;
      }
      const blob = repo.getObject(entry.oid);
      if (!blob) {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: entry.oid,
        size: blob.data.length,
        name: entry.name,
        path,
      });
      return;
    }
    if (entry.mode !== '40000' && entry.mode !== '040000') {
      notFound(res);
      return;
    }
    treeOid = entry.oid;
  }
  // The repository root.
  sendJson(res, 200, dirListing(repo, treeOid, ''));
}

function parseTreeOf(repo: Repo, treeOid: string): { mode: string; name: string; oid: string }[] {
  const obj = repo.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const entries: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  const data = obj.data;
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

function dirListing(repo: Repo, treeOid: string, basePath: string): Json[] {
  return parseTreeOf(repo, treeOid).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const blob = isDir ? null : repo.getObject(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
      sha: entry.oid,
      size: blob ? blob.data.length : 0,
      encoding: isDir ? '' : 'base64',
    };
  });
}

function putContent(res: ServerResponse, repo: Repo, path: string, body: Json): void {
  const branch = strOr(body.branch, repo.defaultBranch);
  const contentB64 = str(body.content);
  const message = strOr(body.message, 'Update file');
  const tip = repo.branchTip(branch);
  const files = tip !== null ? repo.filesAtCommit(tip) : new Map<string, string>();
  const existing = files.get(path) ?? null;
  const providedSha = typeof body.sha === 'string' ? body.sha : null;
  if (existing !== null && providedSha !== null && providedSha !== existing) {
    sendJson(res, 409, { message: 'Conflict: the sha does not match the current file' });
    return;
  }
  let data: Buffer;
  try {
    data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    sendJson(res, 422, { message: 'Validation Failed: content is not base64' });
    return;
  }
  const blobOid = repo.putObject('blob', data);
  const commitSha = commitFileChange(repo, branch, path, blobOid, message);
  sendJson(res, existing !== null ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
}

function deleteContent(res: ServerResponse, repo: Repo, path: string, body: Json): void {
  const branch = strOr(body.branch, repo.defaultBranch);
  const message = strOr(body.message, 'Delete file');
  const tip = repo.branchTip(branch);
  const files = tip !== null ? repo.filesAtCommit(tip) : new Map<string, string>();
  if (!files.has(path)) {
    notFound(res);
    return;
  }
  const commitSha = commitFileChange(repo, branch, path, null, message);
  sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
}

function handleIssues(store: Store, res: ServerResponse, url: URL, repo: Repo, parts: string[], method: string, body: Json, origin: string): void {
  if (parts.length === 0) {
    if (method === 'POST') {
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : str(asRecord(entry)?.name);
          if (name !== '') labelNames.push(name);
        }
      }
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
          return;
        }
      }
      const issue = createIssueRecord(store, repo, strOr(body.title, ''), strOr(body.body, ''), labelNames);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice, link } = pageSlice(url, list, origin);
      sendJson(res, 200, slice.map((issue) => issueJson(repo, issue)), link !== null ? { link } : {});
      return;
    }
    notFound(res);
    return;
  }
  const number = Number(parts[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (parts.length === 1) {
    if (!issue) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : str(asRecord(entry)?.name);
          if (name !== '' && repo.labels.has(name)) names.push(name);
        }
        issue.labels = names;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }
  if (parts.length === 2 && parts[1] === 'comments') {
    if (!issue) {
      notFound(res);
      return;
    }
    if (method === 'POST') {
      const comment = { id: store.nextCommentId(), body: strOr(body.body, ''), seq: store.nextSeq() };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(repo, comment));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, comment)));
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
}

function handlePulls(store: Store, res: ServerResponse, url: URL, repo: Repo, parts: string[], method: string, body: Json, origin: string): void {
  if (parts.length === 0) {
    if (method === 'POST') {
      const headRaw = str(body.head);
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const base = strOr(body.base, repo.defaultBranch);
      if (head === '' || repo.branchTip(head) === null) {
        sendJson(res, 422, { message: 'Validation Failed: head branch does not exist' });
        return;
      }
      if (repo.branchTip(base) === null) {
        sendJson(res, 422, { message: 'Validation Failed: base branch does not exist' });
        return;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this branch' });
          return;
        }
      }
      const pull = createPullRecord(store, repo, { title: strOr(body.title, ''), body: strOr(body.body, ''), head, base });
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const { slice, link } = pageSlice(url, list, origin);
      sendJson(res, 200, slice.map((pull) => pullJson(repo, pull)), link !== null ? { link } : {});
      return;
    }
    notFound(res);
    return;
  }
  const number = Number(parts[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (parts.length === 1 && method === 'GET') {
    if (!pull) {
      notFound(res);
      return;
    }
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    if (!pull) {
      notFound(res);
      return;
    }
    const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
    const headSha = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
    // Diff against the merge base so a moved base does not invent changes.
    const mergeBase = repo.mergeBase(baseSha, headSha) ?? baseSha;
    const changes = diffFiles(repo, mergeBase, headSha);
    const files = changes.map((change) => {
      const oldData = change.baseOid !== null ? repo.getObject(change.baseOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const newData = change.headOid !== null ? repo.getObject(change.headOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const additions = change.headOid === null ? 0 : lineCount(newData);
      const deletions = change.baseOid === null ? 0 : lineCount(oldData);
      return {
        filename: change.path,
        status: change.status === 'modified' ? 'modified' : change.status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: change.headOid ?? ZERO_OID,
      };
    });
    sendJson(res, 200, files);
    return;
  }
  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    if (!pull) {
      notFound(res);
      return;
    }
    if (pull.merged) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable: already merged' });
      return;
    }
    const sha = mergePullRecord(repo, pull);
    if (sha === null) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable: conflict' });
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------
// git smart HTTP

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function advertisementV0(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTarget = repo.branchTip(repo.defaultBranch);
    refs.forEach(([name, oid], index) => {
      if (index === 0) parts.push(pktLine(`${headTarget ?? oid} HEAD\0${caps}\n`));
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = repo.peeled(oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    });
    if (headTarget === null) {
      // HEAD was not the first line's ref; the loop above still named a tip.
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'object-format=sha1\n', 'ls-refs=unborn\n', 'fetch=shallow\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const url = new URL(req.url ?? '/', 'http://entry');
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    notFound(res);
    return;
  }
  if (!authed(req)) {
    requiresAuth(res);
    return;
  }
  const repo = store.claimRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    sendRaw(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
    return;
  }
  sendRaw(res, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_514;
  if (pack.length === 0) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1])])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return packets;
}

function lsRefsReply(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.branchTip(repo.defaultBranch);
  if (keep('HEAD')) {
    if (headTip !== null) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = repo.peeled(oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function fetchReply(repo: Repo, args: FetchArgs, version2: boolean): Buffer {
  const { objects, boundary, included } = fetchObjectSet(repo, args.wants, {
    depth: args.depth,
    haveCommits: new Set(args.haves),
    shallowMarks: new Set(args.shallow),
  });
  const pack = writePack([...objects.values()]);
  const parts: Buffer[] = [];
  if (version2) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    const shallowLines: string[] = [];
    if (args.depth !== null || args.shallow.length > 0) {
      for (const oid of boundary) shallowLines.push(`shallow ${oid}\n`);
      // Unshallow the client's old boundary when it is no longer at the edge:
      // it is included now and so are its parents.
      for (const oid of args.shallow) {
        if (boundary.includes(oid) || !included.has(oid)) continue;
        const view = repo.commitView(oid);
        if (view && view.parents.every((parent) => included.has(parent))) shallowLines.push(`unshallow ${oid}\n`);
      }
    }
    if (shallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of shallowLines) parts.push(pktLine(line));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // Protocol v0: shallow lines and NAK as plain packets, then the sideband pack.
  for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  if (!authed(req)) {
    requiresAuth(res);
    return;
  }
  const repo = store.claimRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return;
  }
  const raw = await readBody(req);
  let packets: Packet[];
  try {
    packets = parsePacketStream(raw).packets;
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => (packet.kind === 'data' ? packet.payload.toString('utf8') : ''));
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (lines.length > 0 && lines[0].startsWith('command=')) {
    const command = lines[0].trim().slice('command='.length);
    // Arguments sit after the delim packet; data lines before it are the
    // command and capability lines. Re-split on the raw packets to honour it.
    const argLines: string[] = [];
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (afterDelim && packet.kind === 'data') argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      sendRaw(res, 200, lsRefsReply(repo, argLines), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
      for (const line of argLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
      }
      sendRaw(res, 200, fetchReply(repo, args, true), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: 'Unknown command' });
    return;
  }
  if (!wantsV2) {
    // Protocol v0: wants in the first section, haves after the flush. The
    // stream parser stops at the first flush, so re-read the whole body in
    // two sections manually.
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    const text = raw.toString('latin1');
    void text;
    let cursor = 0;
    let section = 0;
    while (cursor + 4 <= raw.length) {
      const header = raw.subarray(cursor, cursor + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = parseInt(header, 16);
      if (length === 0) {
        cursor += 4;
        section += 1;
        if (section >= 2) break;
        continue;
      }
      if (length < 4) {
        cursor += 4;
        continue;
      }
      const payload = raw.subarray(cursor + 4, cursor + length).toString('utf8').replace(/\n$/, '');
      cursor += length;
      const line = payload.split('\0')[0];
      if (section === 0) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
      } else if (line.startsWith('have ')) {
        args.haves.push(line.slice(5).trim());
      }
    }
    sendRaw(res, 200, fetchReply(repo, args, false), 'application/x-git-upload-pack-result');
    return;
  }
  sendJson(res, 400, { message: 'Bad request' });
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  if (!authed(req)) {
    requiresAuth(res);
    return;
  }
  const repo = store.claimRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return;
  }
  const raw = await readBody(req);
  let commands: RefCommand[] = [];
  let pack = Buffer.alloc(0);
  let sideband = false;
  try {
    const { packets, rest } = parsePacketStream(raw);
    pack = rest;
    commands = packets
      .filter((packet) => packet.kind === 'data')
      .map((packet, index) => {
        const text = (packet.kind === 'data' ? packet.payload : Buffer.alloc(0)).toString('utf8');
        const [line, caps] = text.split('\0');
        const trimmed = line.replace(/\n$/, '');
        const parts = trimmed.split(' ');
        return { oldOid: parts[0] ?? ZERO_OID, newOid: parts[1] ?? ZERO_OID, ref: parts[2] ?? '', caps: index === 0 ? (caps ?? '') : '' };
      })
      .filter((command) => command.ref.startsWith('refs/'));
    sideband = commands.length > 0 && commands[0].caps.includes('side-band-64k');
    const wantsReport = commands.length > 0 && commands[0].caps.includes('report-status');
    if (pack.length > 0 && commands.some((command) => command.newOid !== ZERO_OID)) {
      const objects = readPack(pack, (oid) => repo.getObject(oid));
      for (const [oid, obj] of objects) {
        if (!repo.getObject(oid)) repo.objects.set(oid, obj);
      }
    }
    const results: { ref: string; ok: boolean; reason: string }[] = [];
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        repo.refs.delete(command.ref);
        if (command.ref === `refs/heads/${repo.defaultBranch}`) {
          const remaining = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/'));
          if (remaining.length > 0) repo.defaultBranch = remaining[0].slice('refs/heads/'.length);
        }
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (!repo.getObject(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.oldOid !== ZERO_OID && current !== undefined && current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
        continue;
      }
      if (current !== undefined && current !== command.newOid) {
        const newCommit = repo.peelToCommit(command.newOid);
        if (newCommit === null || !repo.isAncestor(current, newCommit)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    if (!wantsReport) {
      sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
      return;
    }
    const reportLines = ['unpack ok\n', ...results.map((result) => (result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`))];
    const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
    if (sideband) {
      const packets = sidebandPackets(report);
      sendRaw(res, 200, Buffer.concat([...packets, PKT_FLUSH]), 'application/x-git-receive-pack-result');
    } else {
      sendRaw(res, 200, report, 'application/x-git-receive-pack-result');
    }
  } catch {
    // A malformed push must never take the server down.
    if (!res.headersSent) sendJson(res, 400, { message: 'Bad request' });
  }
}

// ---------------------------------------------------------------------------
// GraphQL v4

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'files', 'commits', 'additions', 'deletions', 'changedFiles', 'url', 'author', 'createdAt', 'updatedAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
};

function gqlIssue(repo: Repo, issue: Issue): Json {
  return {
    __typename: 'Issue',
    id: globalId('Issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { __typename: 'User', login: repo.owner },
    repository: { __typename: 'Repository', name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
    labels: { nodes: issue.labels.map((name) => ({ __typename: 'Label', name })) },
    comments: {
      nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: globalId('IssueComment', repo.id, comment.id), body: comment.body })),
      totalCount: issue.comments.length,
    },
    createdAt: isoOf(issue.seq),
    updatedAt: isoOf(issue.seq),
    closedAt: issue.state === 'closed' ? isoOf(issue.seq) : null,
  };
}

function gqlPull(repo: Repo, pull: Pull): Json {
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  const headSha = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const mergeBase = repo.mergeBase(baseSha, headSha) ?? baseSha;
  const files = diffFiles(repo, mergeBase, headSha).map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path, additions: 0, deletions: 0 }));
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    mergeable: pull.merged || pull.state === 'closed' ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: headSha,
    baseRefOid: baseSha,
    files: { nodes: files, totalCount: files.length },
    url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: { __typename: 'User', login: repo.owner },
    createdAt: isoOf(pull.seq),
    updatedAt: isoOf(pull.seq),
    mergedAt: pull.merged ? FIXED_ISO : null,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function gqlRepo(store: Store, repo: Repo, query: string, vars: Json): Json {
  void store;
  const statesMatch = /states\s*:\s*\[([^\]]*)\]/.exec(query);
  const states = statesMatch ? statesMatch[1] : '';
  const orderMatch = /orderBy\s*:\s*\{\s*field\s*:\s*(\w+)\s*,\s*direction\s*:\s*(\w+)/.exec(query);
  const direction = orderMatch?.[2] ?? 'DESC';
  let issues = [...repo.issues.values()];
  if (states.includes('OPEN') && !states.includes('CLOSED')) issues = issues.filter((issue) => issue.state === 'open');
  if (states.includes('CLOSED') && !states.includes('OPEN')) issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));

  const firstMatch = /first\s*:\s*(\d+)/.exec(query);
  let first = firstMatch ? Number(firstMatch[1]) : 100;
  if (typeof vars.first === 'number') first = vars.first;
  const afterMatch = /after\s*:\s*("[^"]*"|\$\w+)/.exec(query);
  let afterCursor: string | null = null;
  if (afterMatch) {
    if (afterMatch[1].startsWith('$')) {
      const varName = afterMatch[1].slice(1);
      if (typeof vars[varName] === 'string') afterCursor = vars[varName] as string;
    } else {
      afterCursor = afterMatch[1].slice(1, -1);
    }
  }
  let startIndex = 0;
  if (afterCursor !== null && afterCursor !== '') {
    try {
      const decoded = Buffer.from(afterCursor, 'base64').toString('utf8');
      const lastNumber = Number(decoded.replace('cursor:', ''));
      const position = issues.findIndex((issue) => issue.number === lastNumber);
      if (position >= 0) startIndex = position + 1;
    } catch {
      startIndex = 0;
    }
  }
  const page = issues.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + first < issues.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;

  const issueNumber = argNumber(query, 'issue(', 'number', vars);
  const pullNumber = argNumber(query, 'pullRequest(', 'number', vars);
  const headTip = repo.branchTip(repo.defaultBranch);

  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: globalId('User', 0) },
    description: repo.description,
    isPrivate: repo.isPrivate,
    url: `/repos/${repo.owner}/${repo.name}`,
    defaultBranchRef: headTip !== null ? { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: isoOf(repo.seq),
    updatedAt: isoOf(repo.seq),
    issue: issueNumber !== null ? (repo.issues.get(issueNumber) ? gqlIssue(repo, repo.issues.get(issueNumber) as Issue) : null) : null,
    issues: {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => gqlIssue(repo, issue)),
      edges: page.map((issue) => ({ node: gqlIssue(repo, issue), cursor: cursorFor(issue.number) })),
      totalCount: issues.length,
      pageInfo: { hasNextPage, endCursor, hasPreviousPage: startIndex > 0, startCursor: page.length > 0 ? cursorFor(page[0].number) : null },
    },
    pullRequest: pullNumber !== null ? (repo.pulls.get(pullNumber) ? gqlPull(repo, repo.pulls.get(pullNumber) as Pull) : null) : null,
    pullRequests: {
      __typename: 'PullRequestConnection',
      nodes: [...repo.pulls.values()].map((pull) => gqlPull(repo, pull)),
      totalCount: repo.pulls.size,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

/** Top-level field names inside the block that follows `marker` in a query. */
function blockFields(query: string, marker: string): string[] {
  const at = query.indexOf(marker);
  if (at < 0) return [];
  const open = query.indexOf('{', at);
  if (open < 0) return [];
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  let word = '';
  const flushWord = (): void => {
    if (word !== '' && depth === 1 && parens === 0) fields.push(word);
    word = '';
  };
  for (let i = open; i < query.length; i += 1) {
    const ch = query[i];
    if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    else if (ch === '{') {
      flushWord();
      depth += 1;
    } else if (ch === '}') {
      flushWord();
      depth -= 1;
      if (depth === 0) break;
    } else if (/[A-Za-z_]/.test(ch) && parens === 0) {
      word += ch;
    } else {
      flushWord();
    }
  }
  flushWord();
  return fields;
}

/** An integer argument inside a call's parentheses, literal or $variable. */
function argNumber(query: string, call: string, key: string, vars: Json): number | null {
  const callAt = query.indexOf(call);
  if (callAt < 0) return null;
  const close = query.indexOf(')', callAt);
  const argsText = query.slice(callAt, close < 0 ? undefined : close);
  const match = new RegExp(`${key}\\s*:\\s*(\\d+|\\$\\w+)`).exec(argsText);
  if (!match) return null;
  if (match[1].startsWith('$')) {
    const value = vars[match[1].slice(1)];
    return typeof value === 'number' ? value : null;
  }
  return Number(match[1]);
}

function argString(query: string, call: string, key: string, vars: Json): string | null {
  const callAt = query.indexOf(call);
  if (callAt < 0) return null;
  const close = query.indexOf(')', callAt);
  const argsText = query.slice(callAt, close < 0 ? undefined : close);
  const match = new RegExp(`${key}\\s*:\\s*("[^"]*"|\\$\\w+)`).exec(argsText);
  if (!match) return null;
  if (match[1].startsWith('$')) {
    const value = vars[match[1].slice(1)];
    return typeof value === 'string' ? value : null;
  }
  return match[1].slice(1, -1);
}

const VIEWER_FIELDS = new Set(['login', 'id', 'name', 'url', 'avatarUrl', 'bio', 'email', 'createdAt', 'updatedAt', '__typename']);

function executeGraphql(store: Store, doc: Json): Json {
  const query = str(doc.query);
  const vars = asRecord(doc.variables) ?? {};
  const errors: { message: string }[] = [];
  const data: Json = {};

  // Introspection: one or more aliased __type lookups.
  const typePattern = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"(\w+)"/g;
  let typeMatch: RegExpExecArray | null;
  let sawType = false;
  while ((typeMatch = typePattern.exec(query)) !== null) {
    sawType = true;
    const key = typeMatch[1] ?? '__type';
    const typeName = typeMatch[2];
    if (typeName === 'SearchType') {
      data[key] = {
        __typename: '__Type',
        name: 'SearchType',
        kind: 'ENUM',
        enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map((name) => ({ __typename: '__EnumValue', name })),
      };
    } else if (TYPE_FIELDS[typeName]) {
      data[key] = {
        __typename: '__Type',
        name: typeName,
        kind: 'OBJECT',
        fields: TYPE_FIELDS[typeName].map((name) => ({
          __typename: '__Field',
          name,
          description: null,
          args: [],
          type: { __typename: '__Type', name: null, kind: 'SCALAR', ofType: null },
          isDeprecated: false,
          deprecationReason: null,
        })),
      };
    } else {
      data[key] = { __typename: '__Type', name: typeName, kind: 'OBJECT', fields: [] };
    }
  }
  if (sawType) return errors.length > 0 ? { data, errors } : { data };

  const input = asRecord(vars.input) ?? asRecord(vars) ?? {};

  // Mutations.
  if (/\bmutation\b/.test(query.slice(0, 80)) || query.includes('createIssue') || query.includes('closeIssue') || query.includes('createPullRequest') || query.includes('mergePullRequest') || query.includes('addComment')) {
    if (query.includes('createIssue') && !query.includes('closeIssue')) {
      const decoded = decodeGlobalId(str(input.repositoryId));
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      if (!repo) {
        errors.push({ message: 'Repository not found' });
        data.createIssue = { issue: null };
      } else {
        const issue = createIssueRecord(store, repo, strOr(input.title, ''), strOr(input.body, ''), []);
        data.createIssue = { issue: gqlIssue(repo, issue) };
      }
      return errors.length > 0 ? { data, errors } : { data };
    }
    if (query.includes('closeIssue')) {
      const decoded = decodeGlobalId(str(input.issueId));
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const issue = repo && decoded ? repo.issues.get(decoded.number) : undefined;
      if (!repo || !issue) {
        errors.push({ message: 'Issue not found' });
        data.closeIssue = { issue: null };
      } else {
        issue.state = 'closed';
        data.closeIssue = { issue: gqlIssue(repo, issue) };
      }
      return errors.length > 0 ? { data, errors } : { data };
    }
    if (query.includes('createPullRequest')) {
      const decoded = decodeGlobalId(str(input.repositoryId));
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      if (!repo) {
        errors.push({ message: 'Repository not found' });
        data.createPullRequest = { pullRequest: null };
      } else {
        const pull = createPullRecord(store, repo, {
          title: strOr(input.title, ''),
          body: strOr(input.body, ''),
          head: strOr(input.headRefName, ''),
          base: strOr(input.baseRefName, repo.defaultBranch),
        });
        data.createPullRequest = { pullRequest: gqlPull(repo, pull) };
      }
      return errors.length > 0 ? { data, errors } : { data };
    }
    if (query.includes('mergePullRequest')) {
      const decoded = decodeGlobalId(str(input.pullRequestId));
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const pull = repo && decoded ? repo.pulls.get(decoded.number) : undefined;
      if (!repo || !pull) {
        errors.push({ message: 'Pull request not found' });
        data.mergePullRequest = { pullRequest: null };
      } else {
        const mergedSha = pull.merged ? pull.mergeCommitSha : mergePullRecord(repo, pull);
        if (mergedSha === null) errors.push({ message: 'Pull request is not mergeable' });
        data.mergePullRequest = { pullRequest: gqlPull(repo, pull) };
      }
      return errors.length > 0 ? { data, errors } : { data };
    }
    if (query.includes('addComment')) {
      const decoded = decodeGlobalId(str(input.subjectId));
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const issue = repo && decoded ? repo.issues.get(decoded.number) : undefined;
      if (!repo || !issue) {
        errors.push({ message: 'Subject not found' });
        data.addComment = { commentEdge: null };
      } else {
        const comment = { id: store.nextCommentId(), body: strOr(input.body, ''), seq: store.nextSeq() };
        issue.comments.push(comment);
        data.addComment = {
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, comment.id), body: comment.body },
          },
        };
      }
      return errors.length > 0 ? { data, errors } : { data };
    }
  }

  // Viewer (with unknown-field reporting).
  if (/\bviewer\b/.test(query)) {
    const login = store.viewerLogin() ?? 'forge';
    const requested = blockFields(query, 'viewer');
    const viewer: Json = { __typename: 'User', login, id: globalId('User', 0), name: login };
    for (const field of requested) {
      if (!VIEWER_FIELDS.has(field)) {
        errors.push({ message: `Field '${field}' doesn't exist on type 'User'` });
      }
    }
    data.viewer = viewer;
  }

  // node(id:).
  const nodeId = argString(query, 'node(', 'id', vars);
  if (nodeId !== null) {
    const decoded = decodeGlobalId(nodeId);
    let node: Json | null = null;
    if (decoded) {
      const repo = store.reposById.get(decoded.repoId);
      if (repo && decoded.kind === 'Repository') {
        node = { ...gqlRepo(store, repo, '', {}), issue: undefined, issues: undefined, pullRequest: undefined, pullRequests: undefined };
        delete node.issue;
        delete node.issues;
        delete node.pullRequest;
        delete node.pullRequests;
      } else if (repo && decoded.kind === 'Issue') {
        const issue = repo.issues.get(decoded.number);
        node = issue ? gqlIssue(repo, issue) : null;
      } else if (repo && decoded.kind === 'PullRequest') {
        const pull = repo.pulls.get(decoded.number);
        node = pull ? gqlPull(repo, pull) : null;
      }
    }
    data.node = node;
  }

  // repository(owner:, name:).
  if (/\brepository\s*\(/.test(query)) {
    const ownerArg = argString(query, 'repository(', 'owner', vars);
    const nameArg = argString(query, 'repository(', 'name', vars);
    if (ownerArg !== null && nameArg !== null) {
      const repo = store.claimRepo(ownerArg, nameArg);
      data.repository = repo === null ? null : gqlRepo(store, repo, query, vars);
    }
  }

  if (Object.keys(data).length === 0 && errors.length === 0) {
    errors.push({ message: 'Unsupported query' });
  }
  return errors.length > 0 ? { data, errors } : { data };
}

async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    requiresAuth(res);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeGraphql(store, asRecord(entry) ?? {}));
    sendJson(res, 200, results);
    return;
  }
  const doc = asRecord(parsed);
  if (doc === null) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  sendJson(res, 200, executeGraphql(store, doc));
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, JSON-RPC 2.0)

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'forge', title: 'Forge', version: '1.0.0' };
const MCP_CAPABILITIES = { tools: { listChanged: false } };

interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (store: Store, args: Json) => Json;
}

function requireString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`missing required argument: ${key}`);
  return value;
}

function mcpRepo(store: Store, args: Json): Repo {
  const owner = requireString(args, 'owner');
  const name = requireString(args, 'repo');
  const repo = store.claimRepo(owner, name);
  if (repo === null) throw new Error(`repository not found: ${owner}/${name}`);
  return repo;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: (store, args) => {
      const name = requireString(args, 'name');
      const existing = store.repoByName(name);
      if (existing !== null) return repoJson(existing);
      const owner = store.viewerLogin() ?? '';
      const repo = store.createRepo(owner, name, strOr(args.description, ''), args.private === true);
      if (repo === null) throw new Error('repository already exists');
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    run: (store, args) => repoJson(mcpRepo(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
    run: (store, args) => {
      const repo = mcpRepo(store, args);
      const issue = createIssueRecord(store, repo, requireString(args, 'title'), strOr(args.body, ''), []);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    run: (store, args) => {
      const repo = mcpRepo(store, args);
      const state = strOr(args.state, 'open');
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return { issues: list.map((issue) => issueJson(repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
    run: (store, args) => {
      const repo = mcpRepo(store, args);
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      if (repo.branchTip(head) === null) throw new Error(`head branch does not exist: ${head}`);
      if (repo.branchTip(base) === null) throw new Error(`base branch does not exist: ${base}`);
      const pull = createPullRecord(store, repo, { title: requireString(args, 'title'), body: strOr(args.body, ''), head, base });
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
    run: (store, args) => {
      const repo = mcpRepo(store, args);
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) throw new Error('missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`pull request not found: ${number}`);
      if (!pull.merged) {
        const sha = mergePullRecord(repo, pull);
        if (sha === null) throw new Error('pull request is not mergeable');
      }
      return pullJson(repo, pull);
    },
  },
];

function toolListJson(): Json[] {
  return MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

function rpcResult(id: unknown, result: Json): Json {
  return { jsonrpc: '2.0', id: id as string | number | null, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id as string | number | null, error: { code, message } };
}

function handleRpcMessage(store: Store, message: Json): Json | null {
  const method = str(message.method);
  const id = 'id' in message ? message.id : undefined;
  const params = asRecord(message.params) ?? {};
  if (id === undefined) {
    // A notification: acknowledged with no response body.
    return null;
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: MCP_CAPABILITIES,
      serverInfo: MCP_SERVER_INFO,
      instructions: 'A GitHub-compatible forge. Tools mirror the REST API.',
    });
  }
  if (method === 'initialize') {
    const requested = str(params.protocolVersion);
    const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
    const clientInfo = asRecord(params.clientInfo);
    void clientInfo;
    return rpcResult(id, { protocolVersion, capabilities: MCP_CAPABILITIES, serverInfo: MCP_SERVER_INFO });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: toolListJson() });
  if (method === 'tools/call') {
    const name = str(params.name);
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = asRecord(params.arguments) ?? {};
    try {
      const value = tool.run(store, args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
        isError: false,
      });
    } catch (error) {
      return rpcError(id, -32602, error instanceof Error ? error.message : 'tool call failed');
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    requiresAuth(res);
    return;
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { 'x-github-request-id': nextRequestId(), allow: 'POST' });
    res.end();
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Json[] = [];
    for (const entry of parsed) {
      const message = asRecord(entry);
      if (message === null) {
        responses.push(rpcError(null, -32600, 'Invalid request'));
        continue;
      }
      const response = handleRpcMessage(store, message);
      if (response !== null) responses.push(response);
    }
    sendJson(res, 200, responses);
    return;
  }
  const message = asRecord(parsed);
  if (message === null) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const response = handleRpcMessage(store, message);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// ---------------------------------------------------------------------------
// router

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        if (pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (pathname === '/api/graphql') {
          await handleGraphql(store, req, res);
          return;
        }
        if (pathname === '/mcp') {
          await handleMcp(store, req, res);
          return;
        }
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          await handleRest(store, req, res);
          return;
        }
        const gitMatch = GIT_PATH.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const name = decodeURIComponent(gitMatch[2]);
          const tail = gitMatch[3];
          if (tail === 'info/refs') handleInfoRefs(store, req, res, owner, name);
          else if (tail === 'git-upload-pack') await handleUploadPack(store, req, res, owner, name);
          else await handleReceivePack(store, req, res, owner, name);
          return;
        }
        notFound(res);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
        else res.end();
      }
    })();
  });
  return server;
}
