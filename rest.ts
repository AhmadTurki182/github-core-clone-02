// rest.ts — REST API handlers for the forge (GitHub-compatible, v3 style).
// All handlers are pure functions over a Store; they return { status, body }.

import { VIEWER_ID, isoNow } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { ZERO_OID } from './git.ts';
import { writeFile, deleteFile, pullFiles, mergePull, computeMergeable } from './operations.ts';

export interface RestResult {
  status: number;
  body: unknown;
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const ok = (body: unknown, status = 200): RestResult => ({ status, body });

export function parseQuery(url: string): URLSearchParams {
  return new URL(url, 'http://x').searchParams;
}

function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: r.fullName,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.isPrivate,
    default_branch: r.defaultBranch,
    description: r.description,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    html_url: `https://example.invalid/${r.fullName}`,
  };
}

function issueJson(i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l) => ({ name: l })),
    user: { login: 'adaiversen', id: VIEWER_ID },
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

function pullJson(ctx: RestContext, repo: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    mergeable: computeMergeable(repo, p),
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.headRef, sha: p.headSha },
    base: { ref: p.baseRef, sha: p.baseSha },
    user: { login: 'adaiversen', id: VIEWER_ID },
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function isValidName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && /^[A-Za-z0-9._-]+$/.test(name);
}

export interface RestContext {
  store: Store;
  viewerLogin: string;
  viewerId: number;
}

/** GET /api/v3/ — API root. */
export function apiRoot(): RestResult {
  return ok({ current_user_url: '/api/v3/user' });
}

/** GET /api/v3/meta — installation metadata. */
export function meta(): RestResult {
  return ok({ installed_version: '1.0.0', forge: 'forge' });
}

/** GET /api/v3/user/repos and GET /api/v3/users/:owner/repos. */
export function listRepos(ctx: RestContext, owner: string, query: URLSearchParams): RestResult {
  const repos = ctx.store.listReposByOwner(owner);
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const start = (page - 1) * perPage;
  return ok(repos.slice(start, start + perPage).map(repoJson));
}

/** POST /api/v3/user/repos — create a repo for the viewer. */
export function createRepo(ctx: RestContext, body: unknown): RestResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name : '';
  if (!isValidName(name)) return err(422, 'name is required');
  if (ctx.store.getRepo(ctx.viewerLogin, name)) return err(422, 'Repository already exists');
  const repo = ctx.store.createRepo(ctx.viewerLogin, name, {
    isPrivate: b.private === true,
    description: typeof b.description === 'string' ? b.description : undefined,
  });
  return ok(repoJson(repo), 201);
}

/** GET /api/v3/repos/:owner/:repo. */
export function getRepo(ctx: RestContext, owner: string, name: string): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  return ok(repoJson(repo));
}

/** PATCH /api/v3/repos/:owner/:repo. */
export function patchRepo(ctx: RestContext, owner: string, name: string, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.description === 'string') repo.description = b.description;
  if (typeof b.default_branch === 'string' && repo.refs.has(`refs/heads/${b.default_branch}`)) {
    repo.defaultBranch = b.default_branch;
  }
  if (typeof b.private === 'boolean') repo.isPrivate = b.private;
  if (typeof b.name === 'string' && isValidName(b.name) && b.name !== name) {
    ctx.store.renameRepo(repo, b.name);
  }
  repo.updatedAt = isoNow();
  return ok(repoJson(repo));
}

/** DELETE /api/v3/repos/:owner/:repo. */
export function deleteRepo(ctx: RestContext, owner: string, name: string): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  ctx.store.deleteRepo(owner, name);
  return { status: 204, body: null };
}

/** GET /api/v3/repos/:owner/:repo/branches. */
export function listBranches(ctx: RestContext, owner: string, name: string): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const out: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  return ok(out);
}

/** GET /api/v3/repos/:owner/:repo/commits. */
export function listCommits(ctx: RestContext, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const sha = query.get('sha');
  const refName = sha ?? `refs/heads/${repo.defaultBranch}`;
  let tip = repo.refs.get(refName) ?? repo.refs.get(`refs/heads/${refName}`);
  if (!tip && sha) tip = sha;
  if (!tip) return ok([]);
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const text = obj.data.toString('utf8');
    const blank = text.indexOf('\n\n');
    const message = blank >= 0 ? text.slice(blank + 2) : '';
    out.push({ sha: oid, commit: { message } });
    const header = blank >= 0 ? text.slice(0, blank) : text;
    for (const line of header.split('\n')) {
      if (line.startsWith('parent ')) stack.push(line.slice(7, 47));
    }
  }
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return ok(out.slice((page - 1) * perPage, page * perPage));
}

/** GET /api/v3/repos/:owner/:repo/contents/:path (file or directory listing). */
export function getContents(ctx: RestContext, owner: string, name: string, path: string, query: URLSearchParams): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const ref = query.get('ref') ?? `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  if (!tip) return err(404, 'Not Found');
  const found = lookupPath(repo, tip, path);
  if (!found) return err(404, 'Not Found');
  if (found.type === 'tree') {
    const obj = repo.objects.get(found.oid)!;
    const entries: Array<Record<string, unknown>> = [];
    let off = 0;
    while (off < obj.data.length) {
      const sp = obj.data.indexOf(0x20, off);
      const nul = obj.data.indexOf(0x00, sp);
      const entryName = obj.data.subarray(sp + 1, nul).toString('utf8');
      const oid = obj.data.subarray(nul + 1, nul + 21).toString('hex');
      const child = repo.objects.get(oid);
      const kind = child?.type === 'tree' ? 'dir' : 'file';
      entries.push({
        name: entryName,
        path: path ? `${path}/${entryName}` : entryName,
        sha: oid,
        type: kind,
        size: child?.type === 'blob' ? child.data.length : 0,
      });
      off = nul + 21;
    }
    return ok(entries);
  }
  const blob = repo.objects.get(found.oid)!;
  return ok({
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: blob.data.toString('base64'),
    sha: found.oid,
  });
}

function lookupPath(repo: Repo, commitOid: string, path: string): { oid: string; type: 'blob' | 'tree' } | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const text = commit.data.toString('utf8');
  const treeLine = text.split('\n').find((l) => l.startsWith('tree '));
  if (!treeLine) return null;
  let current = treeLine.slice(5, 45);
  if (!path) {
    return { oid: current, type: 'tree' };
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const treeObj = repo.objects.get(current);
    if (!treeObj || treeObj.type !== 'tree') return null;
    let found: { oid: string } | null = null;
    let off = 0;
    while (off < treeObj.data.length) {
      const sp = treeObj.data.indexOf(0x20, off);
      const nul = treeObj.data.indexOf(0x00, sp);
      const entryName = treeObj.data.subarray(sp + 1, nul).toString('utf8');
      const oid = treeObj.data.subarray(nul + 1, nul + 21).toString('hex');
      if (entryName === segments[i]) {
        found = { oid };
        break;
      }
      off = nul + 21;
    }
    if (!found) return null;
    const isLast = i === segments.length - 1;
    if (isLast) {
      const obj = repo.objects.get(found.oid);
      if (!obj) return null;
      return { oid: found.oid, type: obj.type === 'tree' ? 'tree' : 'blob' };
    }
    current = found.oid;
  }
  return null;
}

/** PUT /api/v3/repos/:owner/:repo/contents/:path — create or update a file. */
export function putContents(ctx: RestContext, owner: string, name: string, path: string, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message : 'Update file';
  const contentB64 = typeof b.content === 'string' ? b.content : '';
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  // A stale `sha` (the blob being replaced) is a 409.
  const providedSha = typeof b.sha === 'string' ? b.sha : undefined;
  let exists = false;
  if (tip && providedSha) {
    const current = lookupPath(repo, tip, path);
    if (current && current.oid.toLowerCase() !== providedSha.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    exists = current !== null;
  } else if (tip) {
    exists = lookupPath(repo, tip, path) !== null;
  }
  const newContent = Buffer.from(contentB64, 'base64');
  const result = writeFile(repo, path, newContent, tip, message, ctx.viewerLogin);
  repo.refs.set(refName, result.commitOid);
  repo.packCache.clear();
  repo.updatedAt = isoNow();
  return ok(
    {
      content: { name: path.split('/').pop() ?? path, path, sha: result.blobOid, size: newContent.length, encoding: 'base64', content: contentB64 },
      commit: { sha: result.commitOid, message },
    },
    exists ? 200 : 201,
  );
}

/** DELETE /api/v3/repos/:owner/:repo/contents/:path. */
export function deleteContents(ctx: RestContext, owner: string, name: string, path: string, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message : 'Delete file';
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (!tip) return err(404, 'Not Found');
  const result = deleteFile(repo, path, tip, message, ctx.viewerLogin);
  if (!result) return err(404, 'Not Found');
  repo.refs.set(refName, result.commitOid);
  repo.packCache.clear();
  repo.updatedAt = isoNow();
  return ok({ commit: { sha: result.commitOid, message } });
}

// ---------------------------------------------------------------- issues

export function createIssue(ctx: RestContext, owner: string, name: string, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title : '';
  if (!title) return err(422, 'title is required');
  const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map((l) => String(l)) : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return err(422, `Label does not exist: ${label}`);
  }
  const issue = ctx.store.createIssue(repo, title, typeof b.body === 'string' ? b.body : '', labels);
  return ok(issueJson(issue), 201);
}

export function listIssues(ctx: RestContext, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  const sorted = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return ok(sorted.slice((page - 1) * perPage, page * perPage).map(issueJson));
}

export function getIssue(ctx: RestContext, owner: string, name: string, number: number): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');
  return ok(issueJson(issue));
}

export function patchIssue(ctx: RestContext, owner: string, name: string, number: number, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string') issue.body = b.body;
  if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
  if (Array.isArray(b.labels)) {
    const labels = (b.labels as unknown[]).map((l) => String(l));
    for (const label of labels) {
      if (!repo.labels.has(label)) return err(422, `Label does not exist: ${label}`);
    }
    issue.labels = labels;
  }
  issue.updatedAt = isoNow();
  return ok(issueJson(issue));
}

export function createComment(ctx: RestContext, owner: string, name: string, number: number, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.body === 'string' ? b.body : '';
  if (!text) return err(422, 'body is required');
  const comment = { id: repo.nextComment++, body: text, createdAt: isoNow(), updatedAt: isoNow() };
  issue.comments.push(comment);
  return ok({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt }, 201);
}

export function listComments(ctx: RestContext, owner: string, name: string, number: number): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');
  return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt, updated_at: c.updatedAt })));
}

/** POST /api/v3/repos/:owner/:repo/labels — create a label. */
export function createLabel(ctx: RestContext, owner: string, name: string, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  const labelName = typeof b.name === 'string' ? b.name : '';
  if (!labelName) return err(422, 'name is required');
  const label = {
    name: labelName,
    color: typeof b.color === 'string' ? b.color : 'ededed',
    description: typeof b.description === 'string' ? b.description : '',
  };
  repo.labels.set(labelName, label);
  return ok(label, 201);
}

// ---------------------------------------------------------------- pulls

export function createPull(ctx: RestContext, owner: string, name: string, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const b = (body ?? {}) as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title : '';
  if (!title) return err(422, 'title is required');
  const head = typeof b.head === 'string' ? b.head : '';
  const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
  if (!head) return err(422, 'head is required');
  const headRef = `refs/heads/${head}`;
  const headSha = repo.refs.get(headRef);
  if (!headSha) return err(422, `head branch not found: ${head}`);
  const baseRef = `refs/heads/${base}`;
  const baseSha = repo.refs.get(baseRef);
  if (!baseSha) return err(422, `base branch not found: ${base}`);
  // Precompute the changed files for the stored Pull.
  const tmpPull: Pull = {
    id: 0,
    number: 0,
    title,
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeable: true,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    files: [],
    mergeCommitSha: null,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  };
  const files = pullFiles(repo, tmpPull).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    sha: f.sha,
  }));
  const pull = ctx.store.createPull(repo, title, typeof b.body === 'string' ? b.body : '', head, headSha, base, baseSha, files);
  return ok(pullJson(ctx, repo, pull), 201);
}

export function listPulls(ctx: RestContext, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return ok(pulls.slice((page - 1) * perPage, page * perPage).map((p) => pullJson(ctx, repo, p)));
}

export function getPull(ctx: RestContext, owner: string, name: string, number: number): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');
  return ok(pullJson(ctx, repo, pull));
}

export function listPullFiles(ctx: RestContext, owner: string, name: string, number: number): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');
  const files = pullFiles(repo, pull);
  return ok(
    files.map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    })),
  );
}

export function mergePullEndpoint(ctx: RestContext, owner: string, name: string, number: number, body: unknown): RestResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== ctx.viewerLogin) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');
  if (pull.state !== 'open') return err(409, 'Pull request is already closed');
  if (!computeMergeable(repo, pull)) return err(405, 'Pull request cannot be merged due to a conflict');
  const result = mergePull(ctx.store, repo, pull, ctx.viewerLogin);
  if (!result) return err(409, 'Pull request cannot be merged');
  return ok({ sha: result.mergeSha, merged: true, message: 'Pull request successfully merged' });
}

export { ZERO_OID };
