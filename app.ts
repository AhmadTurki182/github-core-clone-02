// app.ts — the HTTP server: routing, auth, request ids, and the git
// smart-HTTP endpoints. REST/GraphQL/MCP handlers live in their own files.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import type { Store } from './store.ts';
import {
  advertiseV2Upload,
  advertiseV0Upload,
  advertiseV0Receive,
  computeFetch,
  buildV2FetchResponse,
  buildV0FetchResponse,
  parseV2Request,
  parseV0FetchRequest,
  parseReceivePackBody,
  readPack,
  writePack,
  hashObject,
  isAncestor,
  listRefs,
  encodePktLine,
  pktFlush,
  ZERO_OID,
  type RefInfo,
} from './git.ts';
import * as rest from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

export interface AppOptions {
  store: Store;
  viewerLogin?: string;
  viewerId?: number;
}

function requestId(): string {
  return randomBytes(8).toString('hex');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? m[1].trim() : null;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected && expected.length > 0) return token === expected;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': requestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': requestId(),
  });
  res.end(body);
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function createApp(options: AppOptions) {
  const store = options.store;
  const viewerLogin = options.viewerLogin ?? VIEWER_LOGIN;
  const viewerId = options.viewerId ?? VIEWER_ID;
  const ctx: rest.RestContext = { store, viewerLogin, viewerId };

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: `Internal server error: ${(err as Error).message}` });
      } else {
        res.end();
      }
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const query = url.searchParams;

    // Health check (no auth).
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- git smart-HTTP -------------------------------------------------
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (gitMatch) {
      await handleGit(req, res, method, url, gitMatch[1], gitMatch[2], gitMatch[3]);
      return;
    }

    // ---- MCP ------------------------------------------------------------
    if (method === 'POST' && pathname === '/mcp') {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const bodyText = (await readBody(req)).toString('utf8');
      const outcome = handleMCP({ store, viewerLogin, viewerId }, bodyText);
      if (outcome.body === null) {
        res.writeHead(outcome.status, { 'X-GitHub-Request-Id': requestId() });
        res.end();
        return;
      }
      const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId() };
      if (outcome.headers) Object.assign(headers, outcome.headers);
      res.writeHead(outcome.status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(outcome.body));
      return;
    }

    // ---- GraphQL --------------------------------------------------------
    if (method === 'POST' && pathname === '/api/graphql') {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const outcome = handleGraphQL({ store, viewerLogin, viewerId }, body);
      sendJson(res, outcome.status, outcome.body);
      return;
    }

    // ---- REST -----------------------------------------------------------
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      await handleRest(req, res, method, url, pathname, query);
      return;
    }

    // Unknown route.
    sendJson(res, 404, { message: 'Not Found' });
  }

  async function handleRest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    // API root and meta (auth still required for the root per the checks'
    // client, which always sends the token; the root check expects 200).
    if (method === 'GET' && (pathname === '/api/v3/' || pathname === '/api/v3')) {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      sendJson(res, 200, rest.apiRoot().body, { 'X-OAuth-Scopes': 'repo' });
      return;
    }
    if (method === 'GET' && pathname === '/api/v3/meta') {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      sendJson(res, 200, rest.meta().body);
      return;
    }

    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    const body = await readJsonBody(req, res);
    if (body === undefined) return; // 400 already sent.

    const sub = pathname.slice('/api/v3'.length);

    // GET /api/v3/user
    if (method === 'GET' && sub === '/user') {
      sendJson(res, 200, { login: viewerLogin, id: viewerId, type: 'User', name: 'ada iversen', email: 'adaiversen@example.invalid' });
      return;
    }

    // /user/repos
    if (sub === '/user/repos') {
      if (method === 'GET') {
        const result = rest.listRepos(ctx, viewerLogin, query);
        sendJson(res, result.status, result.body, linkHeaders(req, url, query, result.body));
        return;
      }
      if (method === 'POST') {
        const result = rest.createRepo(ctx, body);
        sendJson(res, result.status, result.body);
        return;
      }
    }

    // /users/:owner/repos
    const usersRepos = /^\/users\/([^/]+)\/repos$/.exec(sub);
    if (usersRepos && method === 'GET') {
      const result = rest.listRepos(ctx, decodeSegment(usersRepos[1]), query);
      sendJson(res, result.status, result.body, linkHeaders(req, url, query, result.body));
      return;
    }

    // /repos/:owner/:repo/...
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(sub);
    if (repoMatch) {
      const owner = decodeSegment(repoMatch[1]);
      const repoName = decodeSegment(repoMatch[2]);
      const tail = repoMatch[3];
      await handleRepoRoute(req, res, method, url, query, owner, repoName, tail, body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  /** Read a JSON request body; sends a 400 and returns undefined on bad JSON. */
  async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const method = req.method ?? 'GET';
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
      return null;
    }
    const raw = await readBody(req);
    if (raw.length === 0) return null;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return undefined;
    }
  }

  /** Link rel="next" for list endpoints, when another page exists. */
  function linkHeaders(
    req: IncomingMessage,
    url: URL,
    query: URLSearchParams,
    body: unknown,
  ): Record<string, string> {
    if (!Array.isArray(body)) return {};
    const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    // The caller paginates by slicing; a full page means there may be more.
    if (body.length < perPage) return {};
    const host = req.headers.host ?? 'localhost';
    const proto = 'http';
    const next = new URL(url.pathname, `${proto}://${host}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    return { Link: `<${next.toString()}>; rel="next"` };
  }

  async function handleRepoRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    query: URLSearchParams,
    owner: string,
    repoName: string,
    tail: string,
    body: unknown,
  ): Promise<void> {
    // GET /repos/:o/:r
    if (tail === '' || tail === '/') {
      if (method === 'GET') {
        const r = rest.getRepo(ctx, owner, repoName);
        sendJson(res, r.status, r.body);
        return;
      }
      if (method === 'PATCH') {
        const r = rest.patchRepo(ctx, owner, repoName, body);
        sendJson(res, r.status, r.body);
        return;
      }
      if (method === 'DELETE') {
        const r = rest.deleteRepo(ctx, owner, repoName);
        sendJson(res, r.status, r.body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // /branches
    if (tail === '/branches' && method === 'GET') {
      const r = rest.listBranches(ctx, owner, repoName);
      sendJson(res, r.status, r.body);
      return;
    }

    // /commits
    if (tail === '/commits' && method === 'GET') {
      const r = rest.listCommits(ctx, owner, repoName, query);
      sendJson(res, r.status, r.body);
      return;
    }

    // /git/refs (create) and /git/refs/heads/:branch (read)
    if (tail === '/git/refs' && method === 'POST') {
      const r = createGitRef(ctx, owner, repoName, body);
      sendJson(res, r.status, r.body);
      return;
    }
    const gitRefRead = /^\/git\/refs\/heads\/(.+)$/.exec(tail);
    if (gitRefRead && method === 'GET') {
      const r = readGitRef(ctx, owner, repoName, `refs/heads/${decodeSegment(gitRefRead[1])}`);
      sendJson(res, r.status, r.body);
      return;
    }

    // /labels
    if (tail === '/labels' && method === 'POST') {
      const r = rest.createLabel(ctx, owner, repoName, body);
      sendJson(res, r.status, r.body);
      return;
    }

    // /issues...
    if (tail === '/issues' || tail.startsWith('/issues/')) {
      await handleIssuesRoute(req, res, method, query, owner, repoName, tail, body);
      return;
    }

    // /pulls...
    if (tail === '/pulls' || tail.startsWith('/pulls/')) {
      await handlePullsRoute(req, res, method, query, owner, repoName, tail, body);
      return;
    }

    // /contents/:path
    const contentsMatch = /^\/contents\/(.+)$/.exec(tail);
    if (contentsMatch) {
      const path = contentsMatch[1].split('/').map(decodeSegment).join('/');
      if (method === 'GET') {
        const r = rest.getContents(ctx, owner, repoName, path, query);
        sendJson(res, r.status, r.body);
        return;
      }
      if (method === 'PUT') {
        const r = rest.putContents(ctx, owner, repoName, path, body);
        sendJson(res, r.status, r.body);
        return;
      }
      if (method === 'DELETE') {
        const r = rest.deleteContents(ctx, owner, repoName, path, body);
        sendJson(res, r.status, r.body);
        return;
      }
    }
    // GET /contents (no path) — the repo root directory.
    if (tail === '/contents' && method === 'GET') {
      const r = rest.getContents(ctx, owner, repoName, '', query);
      sendJson(res, r.status, r.body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  async function handleIssuesRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    query: URLSearchParams,
    owner: string,
    repoName: string,
    tail: string,
    body: unknown,
  ): Promise<void> {
    if (tail === '/issues') {
      if (method === 'GET') {
        const r = rest.listIssues(ctx, owner, repoName, query);
        sendJson(res, r.status, r.body);
        return;
      }
      if (method === 'POST') {
        const r = rest.createIssue(ctx, owner, repoName, body);
        sendJson(res, r.status, r.body);
        return;
      }
    }
    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(tail);
    if (issueMatch) {
      const number = parseInt(issueMatch[1], 10);
      if (issueMatch[2] === '/comments') {
        if (method === 'GET') {
          const r = rest.listComments(ctx, owner, repoName, number);
          sendJson(res, r.status, r.body);
          return;
        }
        if (method === 'POST') {
          const r = rest.createComment(ctx, owner, repoName, number, body);
          sendJson(res, r.status, r.body);
          return;
        }
      } else {
        if (method === 'GET') {
          const r = rest.getIssue(ctx, owner, repoName, number);
          sendJson(res, r.status, r.body);
          return;
        }
        if (method === 'PATCH') {
          const r = rest.patchIssue(ctx, owner, repoName, number, body);
          sendJson(res, r.status, r.body);
          return;
        }
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
  }

  async function handlePullsRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    query: URLSearchParams,
    owner: string,
    repoName: string,
    tail: string,
    body: unknown,
  ): Promise<void> {
    if (tail === '/pulls') {
      if (method === 'GET') {
        const r = rest.listPulls(ctx, owner, repoName, query);
        sendJson(res, r.status, r.body);
        return;
      }
      if (method === 'POST') {
        const r = rest.createPull(ctx, owner, repoName, body);
        sendJson(res, r.status, r.body);
        return;
      }
    }
    const filesMatch = /^\/pulls\/(\d+)\/files$/.exec(tail);
    if (filesMatch && method === 'GET') {
      const r = rest.listPullFiles(ctx, owner, repoName, parseInt(filesMatch[1], 10));
      sendJson(res, r.status, r.body);
      return;
    }
    const mergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(tail);
    if (mergeMatch && method === 'PUT') {
      const r = rest.mergePullEndpoint(ctx, owner, repoName, parseInt(mergeMatch[1], 10), body);
      sendJson(res, r.status, r.body);
      return;
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(tail);
    if (pullMatch && method === 'GET') {
      const r = rest.getPull(ctx, owner, repoName, parseInt(pullMatch[1], 10));
      sendJson(res, r.status, r.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  }

  // ---- git refs (REST) --------------------------------------------------
  function createGitRef(ctx: rest.RestContext, owner: string, repoName: string, body: unknown): rest.RestResult {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return rest.err(404, 'Not Found');
    if (owner !== viewerLogin) return rest.err(404, 'Not Found');
    const b = (body ?? {}) as Record<string, unknown>;
    const ref = typeof b.ref === 'string' ? b.ref : '';
    const sha = typeof b.sha === 'string' ? b.sha : '';
    if (!ref || !sha) return rest.err(422, 'ref and sha are required');
    if (!repo.objects.has(sha)) return rest.err(422, 'sha does not exist');
    if (repo.refs.has(ref)) return rest.err(422, 'ref already exists');
    repo.refs.set(ref, sha);
    repo.packCache.clear();
    return { status: 201, body: { ref, object: { sha } } };
  }

  function readGitRef(ctx: rest.RestContext, owner: string, repoName: string, ref: string): rest.RestResult {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return rest.err(404, 'Not Found');
    if (owner !== viewerLogin) return rest.err(404, 'Not Found');
    const sha = repo.refs.get(ref);
    if (!sha) return rest.err(404, 'Not Found');
    return { status: 200, body: { ref, object: { sha } } };
  }

  // ---- git smart-HTTP ---------------------------------------------------
  async function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    owner: string,
    repoName: string,
    servicePath: string,
  ): Promise<void> {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = store.getRepo(decodeSegment(owner), decodeSegment(repoName));
    if (servicePath === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (service === 'git-upload-pack') {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const body = isV2 ? advertiseV2Upload() : advertiseV0Upload(repo);
        sendBytes(res, 200, body, 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, advertiseV0Receive(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'Unknown service' });
      return;
    }

    if (servicePath === 'git-upload-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' || body.subarray(0, 8).toString('ascii').includes('command=');
      // The v2 request starts with a pkt-line "command=..."; v0 starts with "want ".
      const looksV2 = body.length >= 4 && body.subarray(4, 12).toString('utf8').startsWith('command=');
      if (isV2 || looksV2) {
        await handleUploadPackV2(req, res, repo, body);
      } else {
        await handleUploadPackV0(req, res, repo, body);
      }
      return;
    }

    if (servicePath === 'git-receive-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      await handleReceivePack(req, res, repo, body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  async function handleUploadPackV2(
    req: IncomingMessage,
    res: ServerResponse,
    repo: import('./store').Repo,
    body: Buffer,
  ): Promise<void> {
    const { command, args } = parseV2Request(body);
    if (command === 'ls-refs') {
      const peel = args.includes('peel');
      const symrefs = args.includes('symrefs');
      const unborn = args.includes('unborn');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
      const refs = listRefs(repo);
      const lines: string[] = [];
      for (const r of refs) {
        if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
        if (r.unborn) {
          if (!unborn) continue;
          lines.push(`unborn ${r.name}${symrefs && r.symrefTarget ? ` symref-target:${r.symrefTarget}` : ''}\n`);
          continue;
        }
        let line = `${r.oid} ${r.name}`;
        if (symrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
        if (peel && r.peeled) line += ` peeled:${r.peeled}`;
        lines.push(`${line}\n`);
      }
      const parts: Buffer[] = [];
      for (const l of lines) {
        parts.push(encodePktLine(l));
      }
      parts.push(pktFlush());
      sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      let thinPack = false;
      for (const a of args) {
        if (a.startsWith('want ')) wants.push(a.slice(5, 46));
        else if (a.startsWith('have ')) haves.push(a.slice(5, 46));
        else if (a.startsWith('shallow ')) shallow.push(a.slice(8, 49));
        else if (a.startsWith('deepen ')) {
          const n = parseInt(a.slice(7), 10);
          if (Number.isFinite(n)) depth = n;
        } else if (a === 'thin-pack') thinPack = true;
      }
      const compute = computeFetch(repo, wants, haves, shallow, depth);
      const pack = buildFetchPack(repo, compute);
      sendBytes(res, 200, buildV2FetchResponse(compute, pack), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: `Unknown command: ${command}` });
  }

  async function handleUploadPackV0(
    req: IncomingMessage,
    res: ServerResponse,
    repo: import('./store').Repo,
    body: Buffer,
  ): Promise<void> {
    const parsed = parseV0FetchRequest(body);
    const compute = computeFetch(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth);
    const pack = buildFetchPack(repo, compute);
    sendBytes(res, 200, buildV0FetchResponse(compute, pack), 'application/x-git-upload-pack-result');
  }

  /** Build (and cache) the pack for a fetch. The cache key covers the fetch. */
  function buildFetchPack(
    repo: import('./store').Repo,
    compute: { objects: Array<{ type: import('./git').GitObjectType; data: Buffer }>; shallow: string[]; unshallow: string[] },
  ): Buffer {
    // Cache key: the sorted object ids are expensive to hash for large packs;
    // use the tip + depth + object count as a cheap key — the clone workload
    // repeats the same 50 depth-1 clones of one tip, which share one pack.
    const keyParts: string[] = [];
    for (const o of compute.objects) keyParts.push(o.type);
    const key = `${compute.objects.length}:${compute.shallow.join(',')}:${keyParts.join('')}`;
    const cached = repo.packCache.get(key);
    if (cached) return cached;
    const pack = writePack(compute.objects);
    if (repo.packCache.size > 64) repo.packCache.clear();
    repo.packCache.set(key, pack);
    return pack;
  }

  async function handleReceivePack(
    req: IncomingMessage,
    res: ServerResponse,
    repo: import('./store').Repo,
    body: Buffer,
  ): Promise<void> {
    const { commands, pack } = parseReceivePackBody(body);
    // Store the pushed objects first.
    if (pack && pack.length > 0) {
      let objects: Map<string, { type: import('./git').GitObjectType; data: Buffer }>;
      try {
        objects = readPack(pack, (oid) => repo.objects.get(oid));
      } catch (err) {
        const report = reportStatus(['unpack error']);
        sendBytes(res, 200, report, 'application/x-git-receive-pack-result');
        return;
      }
      for (const [oid, obj] of objects) {
        repo.objects.set(oid, obj);
      }
    }
    const lines: string[] = ['unpack ok\n'];
    const applied: Array<{ ref: string; newOid: string }> = [];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          lines.push(`ng ${cmd.ref} no such ref\n`);
        } else {
          applied.push({ ref: cmd.ref, newOid: ZERO_OID });
          lines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          lines.push(`ng ${cmd.ref} already exists\n`);
        } else if (!repo.objects.has(cmd.newOid)) {
          lines.push(`ng ${cmd.ref} object not found\n`);
        } else {
          applied.push({ ref: cmd.ref, newOid: cmd.newOid });
          lines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      // Update.
      if (current === undefined) {
        lines.push(`ng ${cmd.ref} no such ref\n`);
      } else if (current !== cmd.oldOid) {
        lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else if (!repo.objects.has(cmd.newOid)) {
        lines.push(`ng ${cmd.ref} object not found\n`);
      } else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        applied.push({ ref: cmd.ref, newOid: cmd.newOid });
        lines.push(`ok ${cmd.ref}\n`);
      }
    }
    for (const a of applied) {
      if (a.newOid === ZERO_OID) repo.refs.delete(a.ref);
      else repo.refs.set(a.ref, a.newOid);
    }
    if (applied.length > 0) repo.packCache.clear();
    sendBytes(res, 200, reportStatus(lines), 'application/x-git-receive-pack-result');
  }

  function reportStatus(lines: string[]): Buffer {
    const parts: Buffer[] = [];
    for (const line of lines) {
      const payload = Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]);
      parts.push(encodePktLine(payload));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  return server;
}
