// operations.ts — repo operations that need both the store and git primitives:
// writing/deleting files (contents API), pull-file diffs, and squash merges.

import { isoNow } from './store.ts';
import type { Store, Repo, Pull } from './store.ts';
import {
  hashObject,
  buildCommit,
  buildTree,
  parseCommit,
  parseTree,
  ZERO_OID,
} from './git.ts';
import type { GitObjectType } from './git.ts';

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree to a map of full path -> blob/tree entry (files only). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) tree objects from a flat path map; returns root tree oid. */
export function buildTreeFromMap(repo: Repo, files: Map<string, FlatEntry>): string {
  // Group files by directory, recursively.
  const buildDir = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const subdirs = new Set<string>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of [...subdirs].sort()) {
      const childPrefix = prefix + dir + '/';
      const childOid = buildDir(childPrefix);
      entries.push({ mode: '40000', name: dir, oid: childOid });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const tree = buildTree(entries);
    const oid = hashObject('tree', tree);
    repo.objects.set(oid, { type: 'tree', data: tree });
    return oid;
  };
  return buildDir('');
}

export interface WriteFileResult {
  blobOid: string;
  commitOid: string;
}

/** Write (create or update) a file on a branch; creates one commit. */
export function writeFile(
  repo: Repo,
  path: string,
  content: Buffer,
  tip: string | undefined,
  message: string,
  author: string,
): WriteFileResult {
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  const files = new Map<string, FlatEntry>();
  if (tip) {
    const commit = repo.objects.get(tip);
    if (commit && commit.type === 'commit') {
      const treeOid = parseCommit(commit.data).tree;
      for (const [p, e] of flattenTree(repo, treeOid)) files.set(p, e);
    }
  }
  files.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromMap(repo, files);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip ? [tip] : [],
    author: `${author} <${author}@example.invalid>`,
    committer: `${author} <${author}@example.invalid>`,
    message,
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  return { blobOid, commitOid };
}

/** Delete a file from a branch; creates one commit. Returns null if absent. */
export function deleteFile(
  repo: Repo,
  path: string,
  tip: string,
  message: string,
  author: string,
): { commitOid: string } | null {
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  const treeOid = parseCommit(commit.data).tree;
  const files = flattenTree(repo, treeOid);
  if (!files.has(path)) return null;
  files.delete(path);
  const newTreeOid = buildTreeFromMap(repo, files);
  const commitData = buildCommit({
    tree: newTreeOid,
    parents: [tip],
    author: `${author} <${author}@example.invalid>`,
    committer: `${author} <${author}@example.invalid>`,
    message,
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  return { commitOid };
}

export interface PullFileInfo {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) return { additions: n, deletions: 0 };
  if (n === 0) return { additions: 0, deletions: m };
  // LCS length via a rolling DP (files here are small).
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      cur[j] = oldLines[i] === newLines[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[0];
  return { additions: n - lcs, deletions: m - lcs };
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

/** Diff the base and head trees of a pull request. */
export function pullFiles(repo: Repo, pull: Pull): PullFileInfo[] {
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const base = baseTree ? flattenTree(repo, baseTree) : new Map<string, FlatEntry>();
  const head = headTree ? flattenTree(repo, headTree) : new Map<string, FlatEntry>();
  const out: PullFileInfo[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = blobText(repo, b.oid);
      const { deletions } = lineDiff(oldText, '');
      out.push({
        sha: b.oid,
        filename: path,
        status: 'removed',
        additions: 0,
        deletions,
        changes: deletions,
        patch: `--- a/${path}\n+++ /dev/null\n`,
      });
    } else if (!b && h) {
      const newText = blobText(repo, h.oid);
      const { additions } = lineDiff('', newText);
      out.push({
        sha: h.oid,
        filename: path,
        status: 'added',
        additions,
        deletions: 0,
        changes: additions,
        patch: `--- /dev/null\n+++ b/${path}\n`,
      });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = blobText(repo, b.oid);
      const newText = blobText(repo, h.oid);
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({
        sha: h.oid,
        filename: path,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        patch: `--- a/${path}\n+++ b/${path}\n`,
      });
    }
  }
  return out;
}

export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Find a merge base (a common ancestor) of two commits. */
export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stackA.push(p);
    }
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stackB.push(p);
    }
  }
  return null;
}

export interface MergeOutcome {
  mergeSha: string;
}

/**
 * Squash-merge a pull request onto its base branch. Returns null when the
 * pull cannot be merged (conflict) or is already closed.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull, author: string): MergeOutcome | null {
  if (pull.state !== 'open') return null;
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (!baseTip) return null;
  const headTip = pull.headSha;
  const base = findMergeBase(repo, baseTip, headTip);
  const baseTree = base ? treeOfCommit(repo, base) : null;
  const baseTipTree = treeOfCommit(repo, baseTip);
  const headTree = treeOfCommit(repo, headTip);
  if (!baseTipTree || !headTree) return null;
  const baseMap = baseTree ? flattenTree(repo, baseTree) : new Map<string, FlatEntry>();
  const baseTipMap = flattenTree(repo, baseTipTree);
  const headMap = flattenTree(repo, headTree);
  // Three-way conflict detection: a path changed on both sides of the merge
  // base (to different content) is a conflict.
  const allPaths = new Set<string>([...baseMap.keys(), ...baseTipMap.keys(), ...headMap.keys()]);
  for (const path of allPaths) {
    const inBase = baseMap.get(path)?.oid;
    const inBaseTip = baseTipMap.get(path)?.oid;
    const inHead = headMap.get(path)?.oid;
    const baseChanged = inBaseTip !== inBase;
    const headChanged = inHead !== inBase;
    if (baseChanged && headChanged && inBaseTip !== inHead) {
      return null;
    }
  }
  // Merged tree: start from the base tip, apply the head's changes.
  const merged = new Map<string, FlatEntry>(baseTipMap);
  for (const path of allPaths) {
    const inBase = baseMap.get(path)?.oid;
    const inHead = headMap.get(path);
    const headChanged = (inHead?.oid ?? undefined) !== inBase;
    if (headChanged) {
      if (inHead) merged.set(path, inHead);
      else merged.delete(path);
    }
  }
  const mergedTreeOid = buildTreeFromMap(repo, merged);
  const commitData = buildCommit({
    tree: mergedTreeOid,
    parents: [baseTip],
    author: `${author} <${author}@example.invalid>`,
    committer: `${author} <${author}@example.invalid>`,
    message: pull.title,
  });
  const mergeSha = hashObject('commit', commitData);
  repo.objects.set(mergeSha, { type: 'commit', data: commitData });
  repo.refs.set(baseRef, mergeSha);
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = isoNow();
  repo.updatedAt = isoNow();
  return { mergeSha };
}

/** Whether a pull request can be merged without a conflict (three-way check). */
export function computeMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (!baseTip) return false;
  const headTip = pull.headSha;
  const base = findMergeBase(repo, baseTip, headTip);
  const baseTree = base ? treeOfCommit(repo, base) : null;
  const baseTipTree = treeOfCommit(repo, baseTip);
  const headTree = treeOfCommit(repo, headTip);
  if (!baseTipTree || !headTree) return false;
  const baseMap = baseTree ? flattenTree(repo, baseTree) : new Map<string, FlatEntry>();
  const baseTipMap = flattenTree(repo, baseTipTree);
  const headMap = flattenTree(repo, headTree);
  const allPaths = new Set<string>([...baseMap.keys(), ...baseTipMap.keys(), ...headMap.keys()]);
  for (const path of allPaths) {
    const inBase = baseMap.get(path)?.oid;
    const inBaseTip = baseTipMap.get(path)?.oid;
    const inHead = headMap.get(path)?.oid;
    const baseChanged = inBaseTip !== inBase;
    const headChanged = inHead !== inBase;
    if (baseChanged && headChanged && inBaseTip !== inHead) return false;
  }
  return true;
}

export { ZERO_OID };
export type { GitObjectType };
