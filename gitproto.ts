// The git wire plumbing: pkt-line framing and packfile reading/writing,
// built on node:zlib and node:crypto only. Objects are exchanged as whole
// (undeltified) pack entries; deltas arriving in a push pack are resolved
// against their bases before the objects reach the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTagTarget, parseTree, type GitObj, type ObjType, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse pkt-lines starting at `offset`; returns packets and the offset just past the last one. */
export function parsePackets(buffer: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let cursor = offset;
  while (cursor + 4 <= buffer.length) {
    const header = buffer.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header at ${cursor}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      cursor += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { packets, next: cursor };
}

/** Parse a whole request body of pkt-lines, stopping after the first flush. */
export function parsePacketStream(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const { packets, next } = parsePackets(buffer, 0);
  return { packets, rest: buffer.subarray(next) };
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packHeaderFor(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_TO_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile holding the given objects, in the order supplied. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packHeaderFor(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      delta.copy(out, written, offset, offset + count);
      offset += count;
      written += count;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/** Read a packfile and resolve every object it carries (deltas included). */
export function readPack(pack: Buffer, externalBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0), baseOffset: 0, baseOid: '' };
    if (typeCode === 6) {
      let b = pack[offset];
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset];
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, GitObj>();
  const byOid = new Map<string, RawPackEntry & { resolvedType?: ObjType; resolvedData?: Buffer; oid?: string }>();
  const resolve = (entry: RawPackEntry): GitObj & { oid: string } => {
    const cached = byOid.get(entry.offset.toString());
    if (cached?.resolvedData && cached.resolvedType && cached.oid) {
      return { type: cached.resolvedType, data: cached.resolvedData, oid: cached.oid };
    }
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = [...byOid.values()].find((candidate) => candidate.oid === entry.baseOid);
      if (baseEntry?.resolvedData && baseEntry.resolvedType) {
        type = baseEntry.resolvedType;
        data = applyDelta(baseEntry.resolvedData, entry.data);
      } else {
        // The base may appear later in the pack; resolve it by scanning raw entries.
        let found: GitObj | undefined;
        for (const candidate of raw) {
          if (candidate === entry || candidate.typeCode === 6 || candidate.typeCode === 7) continue;
          const candidateType = CODE_TO_TYPE[candidate.typeCode];
          if (candidateType && hashObject(candidateType, candidate.data) === entry.baseOid) {
            found = { type: candidateType, data: candidate.data };
            break;
          }
        }
        if (!found && externalBase) found = externalBase(entry.baseOid);
        if (!found) throw new Error('ref-delta base missing');
        type = found.type;
        data = applyDelta(found.data, entry.data);
      }
    } else {
      const plain = CODE_TO_TYPE[entry.typeCode];
      if (!plain) throw new Error(`unknown pack type ${entry.typeCode}`);
      type = plain;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    byOid.set(entry.offset.toString(), { ...entry, resolvedType: type, resolvedData: data, oid });
    return { type, data, oid };
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    if (!resolved.has(obj.oid)) resolved.set(obj.oid, { type: obj.type, data: obj.data });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// reachability

/** Every object reachable from a commit/tag oid: the object itself plus its closure. */
export function collectObjects(repo: Repo, tip: string, out: Map<string, GitObj>): void {
  const obj = repo.getObject(tip);
  if (!obj || out.has(tip)) return;
  out.set(tip, obj);
  if (obj.type === 'commit') {
    const view = parseCommit(obj.data);
    collectObjects(repo, view.tree, out);
    for (const parent of view.parents) collectObjects(repo, parent, out);
  } else if (obj.type === 'tree') {
    for (const entry of parseTree(obj.data)) collectObjects(repo, entry.oid, out);
  } else if (obj.type === 'tag') {
    collectObjects(repo, parseTagTarget(obj.data), out);
  }
}

/**
 * The object set for a fetch: commits within the depth budget (counted from
 * the wants), each with its full tree closure, minus what the client already
 * holds. `boundary` collects the commits at the shallow edge.
 */
export function fetchObjectSet(
  repo: Repo,
  wants: readonly string[],
  opts: { depth: number | null; haveCommits: ReadonlySet<string>; shallowMarks: ReadonlySet<string> },
): { objects: Map<string, GitObj>; boundary: string[]; included: Set<string> } {
  // Commits the client possesses: walk from its haves, stopping at the
  // shallow marks (a shallow commit's parents are not held).
  const heldCommits = new Set<string>();
  const heldQueue: string[] = [...opts.haveCommits];
  while (heldQueue.length > 0) {
    const current = heldQueue.shift() as string;
    const commit = repo.peelToCommit(current);
    if (commit === null || heldCommits.has(commit)) continue;
    heldCommits.add(commit);
    if (opts.shallowMarks.has(commit) || opts.shallowMarks.has(current)) continue;
    const view = repo.commitView(commit);
    if (view) for (const parent of view.parents) heldQueue.push(parent);
  }
  const heldObjects = new Map<string, GitObj>();
  for (const commit of heldCommits) {
    const view = repo.commitView(commit);
    if (!view) continue;
    const obj = repo.getObject(commit);
    if (obj) heldObjects.set(commit, obj);
    collectObjects(repo, view.tree, heldObjects);
  }

  // Included commits: breadth-first from the wants within the depth budget.
  const included = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = repo.peelToCommit(want);
    if (commit !== null && !distance.has(commit)) {
      distance.set(commit, 1);
      queue.push(commit);
    }
  }
  const boundarySet = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const dist = distance.get(current) as number;
    included.add(current);
    const view = repo.commitView(current);
    if (!view) continue;
    const atEdge = opts.depth !== null && dist >= opts.depth;
    for (const parent of view.parents) {
      if (atEdge) {
        boundarySet.add(current);
      } else if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
    if (atEdge && view.parents.length === 0) boundarySet.delete(current);
  }
  // A root commit is not a shallow boundary even at the depth edge.
  for (const commit of [...boundarySet]) {
    const view = repo.commitView(commit);
    if (!view || view.parents.length === 0) boundarySet.delete(commit);
  }

  const objects = new Map<string, GitObj>();
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (obj && obj.type === 'tag') collectObjects(repo, want, objects);
  }
  for (const commit of included) {
    const obj = repo.getObject(commit);
    if (obj) objects.set(commit, obj);
    const view = repo.commitView(commit);
    if (view) collectObjects(repo, view.tree, objects);
  }
  for (const oid of heldObjects.keys()) objects.delete(oid);
  return { objects, boundary: [...boundarySet], included };
}
