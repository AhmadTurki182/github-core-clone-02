// mcp.ts — Model Context Protocol server (Streamable HTTP) at POST /mcp.
// Speaks both eras the suite accepts: the modern 2026-07-28 `server/discover`
// (no handshake, no session) and the legacy `initialize` + `notifications/initialized`
// handshake. JSON-RPC 2.0 over a single JSON body; a notification (no id)
// is answered with HTTP 202 and no body.

import { VIEWER_LOGIN, VIEWER_ID, isoNow } from './store.ts';
import type { Store, Repo } from './store.ts';
import { pullFiles, mergePull } from './operations.ts';

export interface MCPContext {
  store: Store;
  viewerLogin: string;
  viewerId: number;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Built once so two tools/list answers serialize byte-for-byte identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

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
  };
}

function issueJson(i: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l) => ({ name: l })),
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

function toolText(payload: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function normalizeToolName(name: string): string {
  const base = name.includes('__') ? name.split('__').pop()! : name;
  return base.toLowerCase();
}

interface ToolCallResult {
  result?: unknown;
  error?: { code: number; message: string };
}

function callTool(ctx: MCPContext, name: string, args: Record<string, unknown>): ToolCallResult {
  const tool = normalizeToolName(name);
  const repoOf = (owner: unknown, repo: unknown): Repo | null => {
    if (typeof owner !== 'string' || typeof repo !== 'string') return null;
    const r = ctx.store.getRepo(owner, repo);
    if (!r || owner !== ctx.viewerLogin) return null;
    return r;
  };

  if (tool === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (!repoName) return { result: toolError('name is required') };
    if (ctx.store.getRepo(ctx.viewerLogin, repoName)) return { result: toolError('Repository already exists') };
    const repo = ctx.store.createRepo(ctx.viewerLogin, repoName, {
      description: typeof args.description === 'string' ? args.description : undefined,
      isPrivate: args.private === true,
    });
    return { result: toolText(repoJson(repo)) };
  }
  if (tool === 'get_repo') {
    const repo = repoOf(args.owner, args.repo);
    if (!repo) return { result: toolError('Not Found') };
    return { result: toolText(repoJson(repo)) };
  }
  if (tool === 'create_issue') {
    const repo = repoOf(args.owner, args.repo);
    if (!repo) return { result: toolError('Not Found') };
    const title = typeof args.title === 'string' ? args.title : '';
    if (!title) return { result: toolError('title is required') };
    const issue = ctx.store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
    return { result: toolText(issueJson(issue)) };
  }
  if (tool === 'list_issues') {
    const repo = repoOf(args.owner, args.repo);
    if (!repo) return { result: toolError('Not Found') };
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.number - a.number);
    return { result: toolText({ issues: issues.map(issueJson) }) };
  }
  if (tool === 'create_pull_request') {
    const repo = repoOf(args.owner, args.repo);
    if (!repo) return { result: toolError('Not Found') };
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    if (!title || !head) return { result: toolError('title and head are required') };
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { result: toolError('head or base branch not found') };
    const tmpPull = {
      id: 0, number: 0, title, body: typeof args.body === 'string' ? args.body : '', state: 'open' as const,
      merged: false, mergedAt: null, mergeable: true, headRef: head, headSha, baseRef: base, baseSha,
      files: [], mergeCommitSha: null, createdAt: isoNow(), updatedAt: isoNow(),
    };
    const files = pullFiles(repo, tmpPull).map((f) => ({
      filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, sha: f.sha,
    }));
    const pull = ctx.store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, headSha, base, baseSha, files);
    return {
      result: toolText({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      }),
    };
  }
  if (tool === 'merge_pull_request') {
    const repo = repoOf(args.owner, args.repo);
    if (!repo) return { result: toolError('Not Found') };
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : NaN;
    if (!Number.isInteger(pullNumber)) return { result: toolError('pull_number is required') };
    const pull = repo.pulls.get(pullNumber);
    if (!pull) return { result: toolError('Not Found') };
    const result = mergePull(ctx.store, repo, pull, ctx.viewerLogin);
    if (!result) return { result: toolError('Pull request cannot be merged') };
    return { result: toolText({ number: pull.number, merged: true, state: pull.state, sha: result.mergeSha }) };
  }
  return { error: { code: -32601, message: `Method not found: ${name}` } };
}

export interface MCPResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function rpcOk(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Handle one POST /mcp. `bodyText` is the raw request body (a JSON-RPC
 * request). Auth is enforced by the caller (a missing token is a 401
 * before this is reached).
 */
export function handleMCP(ctx: MCPContext, bodyText: string): MCPResult {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: rpcError(null, -32700, 'Parse error: the request body is not valid JSON'),
    };
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) gets no JSON-RPC response.
  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcOk(id, {
        resultType: 'DiscoverResult',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      headers: { 'Mcp-Session-Id': 'forge-session-1' },
      body: rpcOk(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcOk(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcOk(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tool name is required') };
    }
    const outcome = callTool(ctx, toolName, args);
    if (outcome.error) {
      return { status: 200, body: rpcError(id, outcome.error.code, outcome.error.message) };
    }
    return { status: 200, body: rpcOk(id, outcome.result) };
  }

  if (isNotification) {
    return { status: 202, body: null };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

export { VIEWER_LOGIN, VIEWER_ID };
