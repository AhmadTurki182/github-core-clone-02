// Git primitives and the smart-HTTP protocol (upload-pack v2/v0,
// receive-pack v0), implemented from the wire contract. No git binary is
// used anywhere; objects are SHA-1 over "<type> <size>\0<data>", packs are
// built and read by hand, and zlib (node:zlib) does the compression.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'ascii');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`);
  lines.push(`committer ${opts.committer} ${opts.timestamp} +0000`);
  lines.push('');
  lines.push(opts.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: Array<string | 'flush' | 'delim' | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) break;
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackObject {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const objects = new Map<string, GitObject>();

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} size mismatch`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before trailer`);

  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const result = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = result;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return result;
  };

  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1. */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** All objects reachable from `tips`, following commits, trees and tags. */
export function collectReachable(repo: Repo, tips: Iterable<string>, maxDepth = Infinity): Set<string> {
  const seen = new Set<string>();
  const stack: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) {
    if (tip !== ZERO_OID && !seen.has(tip)) stack.push({ oid: tip, depth: 0 });
  }
  while (stack.length > 0) {
    const { oid, depth } = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (depth >= maxDepth) continue;
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      for (const p of view.parents) {
        if (!seen.has(p)) stack.push({ oid: p, depth: depth + 1 });
      }
      if (!seen.has(view.tree)) stack.push({ oid: view.tree, depth: depth + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (!seen.has(e.oid)) stack.push({ oid: e.oid, depth: depth + 1 });
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (!seen.has(tag.object)) stack.push({ oid: tag.object, depth: depth + 1 });
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `oid` (i.e. is the update a fast-forward)? */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === ZERO_OID) return true;
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// ---------------------------------------------------------------- protocol

export const AGENT_NAME = 'forge/1.0';

export interface RefInfo {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

export function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  out.push({ oid: headOid ?? ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: headOid === undefined });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const info: RefInfo = { oid, name };
    // An annotated tag peels to the object it points at.
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled) info.peeled = peeled;
    }
    out.push(info);
  }
  return out;
}

/** Follow a tag object to the commit (or object) it ultimately points at. */
export function peelTag(repo: Repo, tagOid: string): string | null {
  let current = tagOid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** v2 capability advertisement for upload-pack. */
export function advertiseV2Upload(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT_NAME}\n`,
  ];
  return encodePktLines([...lines, 'flush']);
}

/** v0 advertisement for upload-pack (refs + capabilities on the first line). */
export function advertiseV0Upload(repo: Repo): Buffer {
  const caps = 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=' + AGENT_NAME;
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktFlush()];
  const refs = listRefs(repo);
  const realRefs = refs.filter((r) => r.name !== 'HEAD');
  if (realRefs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = refs[0];
    parts.push(encodePktLine(`${head.oid} ${head.name}\0${caps}\n`));
    for (const r of realRefs) {
      parts.push(encodePktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(encodePktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v0 advertisement for receive-pack. */
export function advertiseV0Receive(repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=' + AGENT_NAME;
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = listRefs(repo);
  const realRefs = refs.filter((r) => r.name !== 'HEAD');
  if (realRefs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = refs[0];
    parts.push(encodePktLine(`${head.oid} ${head.name}\0${caps}\n`));
    for (const r of realRefs) {
      parts.push(encodePktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(encodePktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface FetchCompute {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute the objects a fetch sends. `wants` are the tips, `haves` the
 * objects the client holds, `shallowBoundaries` its current shallow
 * boundary, `depth` the requested deepen (undefined = full history).
 * Commits are walked by generation from the wants; trees and blobs ride
 * along. Objects the client already holds (reachable from its haves,
 * stopping at its shallow boundaries) are left out.
 */
export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth?: number,
): FetchCompute {
  const boundarySet = new Set(shallowBoundaries);
  // Commits to include, by generation from the wants. A want may also be
  // a tag object: include the tag and follow it to its target.
  const commitLevel = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [];
  const extraObjects = new Set<string>();
  const resolveWant = (oid: string): string | null => {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj) return null;
      if (obj.type === 'tag') {
        extraObjects.add(current);
        current = parseTag(obj.data).object;
        continue;
      }
      return current;
    }
    return current;
  };
  for (const w of wants) {
    if (w === ZERO_OID) continue;
    const target = resolveWant(w);
    if (target && !commitLevel.has(target)) {
      commitLevel.set(target, 0);
      queue.push({ oid: target, level: 0 });
    }
  }
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (includedCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    if (depth !== undefined && level + 1 >= depth) continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!commitLevel.has(p)) {
        commitLevel.set(p, level + 1);
        queue.push({ oid: p, level: level + 1 });
      }
    }
  }
  // Trees and blobs of the included commits, plus any tag objects the
  // wants named directly.
  const included = new Set<string>(extraObjects);
  const treeStack: string[] = [];
  for (const c of includedCommits) {
    included.add(c);
    const tree = parseCommit(repo.objects.get(c)!.data).tree;
    treeStack.push(tree);
  }
  while (treeStack.length > 0) {
    const oid = treeStack.pop()!;
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    included.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) treeStack.push(e.oid);
    }
  }
  // Objects the client already holds: reachable from its haves, but never
  // past a shallow boundary (a boundary's parents are not held).
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const h of haves) {
    if (h !== ZERO_OID && !held.has(h)) heldQueue.push(h);
  }
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop()!;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      if (boundarySet.has(oid)) continue;
      const view = parseCommit(obj.data);
      for (const p of view.parents) heldQueue.push(p);
      heldQueue.push(view.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) heldQueue.push(e.oid);
    } else if (obj.type === 'tag') {
      heldQueue.push(parseTag(obj.data).object);
    }
  }
  // Shallow boundaries of this fetch: included commits whose parents are
  // not included (the depth cutoff). Unshallow: old boundaries that are now
  // included and have an included parent.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const c of includedCommits) {
      const parents = parseCommit(repo.objects.get(c)!.data).parents;
      const anyParentIncluded = parents.some((p) => includedCommits.has(p));
      if (!anyParentIncluded) shallow.push(c);
    }
    for (const b of shallowBoundaries) {
      if (includedCommits.has(b)) {
        const parents = parseCommit(repo.objects.get(b)!.data).parents;
        if (parents.some((p) => includedCommits.has(p))) unshallow.push(b);
      }
    }
  }
  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid)!;
    objects.push({ type: obj.type, data: obj.data });
  }
  return { objects, shallow, unshallow };
}

/** Split a pack into sideband band-1 pkt-lines (max 64k payload each). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is 4 (length) + 1 (band) + chunk; the wire caps a pkt-line
  // at 65520 bytes, so the chunk stays well under that.
  const MAX = 65500;
  for (let off = 0; off < pack.length; off += MAX) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

/** Build a v2 fetch response: acknowledgments, shallow-info, packfile. */
export function buildV2FetchResponse(compute: FetchCompute, pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktDelim());
  if (compute.shallow.length > 0 || compute.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const s of compute.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
    for (const u of compute.unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build a v0 fetch response: NAK/shallow lines, then the sideband pack. */
export function buildV0FetchResponse(compute: FetchCompute, pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const s of compute.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  for (const u of compute.unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v2 command request body into its command and argument lines. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim && line.startsWith('command=')) command = line.slice(8);
    else args.push(line);
  }
  return { command, args };
}

/** Parse a v0 upload-pack request body (want/have/shallow/deepen/done). */
export function parseV0FetchRequest(body: Buffer): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
} {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      wants.push(line.slice(5, 46));
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5, 46));
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8, 49));
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) depth = n;
    } else if (line === 'done') {
      done = true;
    }
  }
  return { wants, haves, shallow, depth, done };
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command list and the pack that follows. */
export function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const packets = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  // Find the end of the command list: scan pkt-lines until the flush.
  let cursor = 0;
  while (cursor + 4 <= body.length) {
    const lenHex = body.subarray(cursor, cursor + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      cursor += 4;
      break;
    }
    cursor += len;
  }
  const packStart = cursor;
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack };
}
