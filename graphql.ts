// graphql.ts — a small GraphQL executor for the forge's v4 surface.
// It parses the documents gh / github-mcp-server actually send (queries,
// mutations, variables, aliases, inline fragments, __type introspection,
// batched operation arrays) and resolves them against the Store. Unknown
// fields are reported as GraphQL errors with HTTP 200, never a 400.

import { VIEWER_LOGIN, VIEWER_ID, isoNow } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { pullFiles, mergePull, computeMergeable } from './operations.ts';

// ------------------------------------------------------------------ parsing

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}

interface GqlInlineFragment {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

type GqlSelection = GqlField | GqlInlineFragment;

interface GqlOperation {
  operationType: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

type Token =
  | { type: 'punct'; value: string }
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'spread'; value: '...' }
  | { type: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push({ type: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ type: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== value) throw new Error(`expected '${value}' but got ${JSON.stringify(t)}`);
  }

  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t.type === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const t = this.next();
    if (t.type !== 'name') throw new Error(`expected a name but got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.peek().type !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): GqlOperation {
    let operationType: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operationType = t.value as 'query' | 'mutation';
      this.next();
    }
    let name: string | null = null;
    const nt = this.peek();
    if (nt.type === 'name') {
      name = this.next().value as string;
    }
    // Variable definitions: skip them (variables are supplied as JSON).
    if (this.acceptPunct('(')) {
      let depth = 1;
      while (depth > 0) {
        const tok = this.next();
        if (tok.type === 'punct' && tok.value === '(') depth += 1;
        else if (tok.type === 'punct' && tok.value === ')') depth -= 1;
        else if (tok.type === 'eof') throw new Error('unterminated variable definitions');
      }
    }
    const selections = this.parseSelectionSet();
    return { operationType, name, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (true) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '}') {
        this.next();
        break;
      }
      if (t.type === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    const t = this.peek();
    if (t.type === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const nt = this.peek();
      if (nt.type === 'name' && nt.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      // Skip directives (none are used by the checks).
      while (this.peek().type === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName();
        if (this.acceptPunct('(')) {
          let depth = 1;
          while (depth > 0) {
            const tok = this.next();
            if (tok.type === 'punct' && tok.value === '(') depth += 1;
            else if (tok.type === 'punct' && tok.value === ')') depth -= 1;
            else if (tok.type === 'eof') throw new Error('unterminated directive');
          }
        }
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selections };
    }
    // Field (possibly aliased).
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.acceptPunct('(')) {
      while (true) {
        const at = this.peek();
        if (at.type === 'punct' && at.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Skip directives.
    while (this.peek().type === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok.type === 'punct' && tok.value === '(') depth += 1;
          else if (tok.type === 'punct' && tok.value === ')') depth -= 1;
          else if (tok.type === 'eof') throw new Error('unterminated directive');
        }
      }
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek().type === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.type === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.type === 'string') return { kind: 'string', value: t.value };
    if (t.type === 'number') {
      const v = Number(t.value);
      return t.value.includes('.') || t.value.includes('e') || t.value.includes('E')
        ? { kind: 'float', value: v }
        : { kind: 'int', value: v };
    }
    if (t.type === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.type === 'punct' && t.value === '[') {
      const values: GqlValue[] = [];
      while (true) {
        const nt = this.peek();
        if (nt.type === 'punct' && nt.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (t.type === 'punct' && t.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (true) {
        const nt = this.peek();
        if (nt.type === 'punct' && nt.value === '}') {
          this.next();
          break;
        }
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token in value: ${JSON.stringify(t)}`);
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

// ------------------------------------------------------------------ ids

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function unb64(s: string): string | null {
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64(`IssueComment:${repo.owner}/${repo.name}#${issue.number}:${commentId}`);
}

interface ParsedGlobalId {
  type: string;
  owner: string;
  name: string;
  number: number;
  extra: string | null;
}

function parseGlobalId(id: string): ParsedGlobalId | null {
  const decoded = unb64(id);
  if (!decoded) return null;
  const m = /^(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^#]+)(?:#(\d+)(?::(\d+))?)?$/.exec(decoded);
  if (!m) return null;
  return {
    type: m[1],
    owner: m[2],
    name: m[3],
    number: m[4] ? parseInt(m[4], 10) : 0,
    extra: m[5] ?? null,
  };
}

// ------------------------------------------------------------------ schema

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments', 'author', 'url'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'];
const SEARCH_TYPE_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];
const USER_FIELDS = ['id', 'login', 'name', 'email'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: USER_FIELDS,
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: SEARCH_TYPE_ENUM,
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ------------------------------------------------------------------ execution

export interface GraphQLContext {
  store: Store;
  viewerLogin: string;
  viewerId: number;
}

interface ExecState {
  errors: Array<{ message: string }>;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function mergeableGql(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return computeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
}

function issueNode(ctx: GraphQLContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issueStateGql(issue.state),
    body: issue.body,
  };
}

function pullNode(ctx: GraphQLContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullStateGql(pull),
    merged: pull.merged,
    mergeable: mergeableGql(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
  };
}

function repoNode(ctx: GraphQLContext, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function userNode(login: string): Record<string, unknown> {
  return { __typename: 'User', id: b64(`User:${login}`), login, name: login, email: `${login}@example.invalid` };
}

function cursorFor(number: number): string {
  return b64(`cursor:${number}`);
}

function numberFromCursor(cursor: string): number | null {
  const decoded = unb64(cursor);
  if (!decoded) return null;
  const m = /^cursor:(\d+)$/.exec(decoded);
  return m ? parseInt(m[1], 10) : null;
}

/** Resolve a selection set against a source object of a given GraphQL type. */
function resolveSelections(
  ctx: GraphQLContext,
  state: ExecState,
  typeName: string,
  source: Record<string, unknown>,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName && sel.typeCondition !== source.__typename) {
        continue;
      }
      const nested = resolveSelections(ctx, state, typeName, source, sel.selections, variables);
      Object.assign(out, nested);
      continue;
    }
    const field = sel;
    const responseKey = field.alias ?? field.name;
    const value = resolveField(ctx, state, typeName, source, field, variables);
    if (value !== undefined) {
      out[responseKey] = value;
    }
  }
  return out;
}

function resolveField(
  ctx: GraphQLContext,
  state: ExecState,
  typeName: string,
  source: Record<string, unknown>,
  field: GqlField,
  variables: Record<string, unknown>,
): unknown {
  const args = resolveArgs(field.args, variables);
  const name = field.name;

  // Introspection entry points on Query.
  if (typeName === 'Query' && name === '__type') {
    const typeArg = args.name as string | undefined;
    if (!typeArg) return null;
    const fields = TYPE_FIELDS[typeArg];
    const enums = TYPE_ENUM_VALUES[typeArg];
    const node: Record<string, unknown> = { __typename: '__Type', __typeName: typeArg, name: typeArg };
    if (field.selections) {
      return resolveSelections(ctx, state, '__Type', node, field.selections, variables);
    }
    return node;
  }
  if (typeName === '__Type') {
    if (name === 'fields') {
      const typeArg = source.__typeName as string | undefined;
      const list = typeArg ? TYPE_FIELDS[typeArg] ?? [] : [];
      return list.map((f) => ({ __typename: '__Field', name: f }));
    }
    if (name === 'enumValues') {
      const typeArg = source.__typeName as string | undefined;
      const list = typeArg ? TYPE_ENUM_VALUES[typeArg] ?? [] : [];
      return list.map((f) => ({ __typename: '__EnumValue', name: f }));
    }
    if (name === 'name') return source.name ?? null;
    state.errors.push({ message: `Cannot query field '${name}' on type '__Type'.` });
    return undefined;
  }

  // Query root.
  if (typeName === 'Query') {
    if (name === 'viewer') {
      const node = userNode(ctx.viewerLogin);
      if (field.selections) return resolveSelections(ctx, state, 'User', node, field.selections, variables);
      return node;
    }
    if (name === 'repository') {
      const owner = args.owner as string | undefined;
      const repoName = args.name as string | undefined;
      if (!owner || !repoName) return null;
      const repo = ctx.store.getRepo(owner, repoName);
      if (!repo || owner !== ctx.viewerLogin) return null;
      const node = repoNode(ctx, repo);
      if (field.selections) return resolveSelections(ctx, state, 'Repository', node, field.selections, variables);
      return node;
    }
    if (name === 'node') {
      const id = args.id as string | undefined;
      if (!id) return null;
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        if (!repo) return null;
        const node = repoNode(ctx, repo);
        if (field.selections) return resolveSelections(ctx, state, 'Repository', node, field.selections, variables);
        return node;
      }
      if (parsed.type === 'Issue') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const issue = repo?.issues.get(parsed.number);
        if (!repo || !issue) return null;
        const node = issueNode(ctx, repo, issue);
        if (field.selections) return resolveSelections(ctx, state, 'Issue', node, field.selections, variables);
        return node;
      }
      if (parsed.type === 'PullRequest') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const pull = repo?.pulls.get(parsed.number);
        if (!repo || !pull) return null;
        const node = pullNode(ctx, repo, pull);
        if (field.selections) return resolveSelections(ctx, state, 'PullRequest', node, field.selections, variables);
        return node;
      }
      return null;
    }
    state.errors.push({ message: `Cannot query field '${name}' on type 'Query'.` });
    return undefined;
  }

  // User.
  if (typeName === 'User') {
    if (name === 'login') return source.login ?? null;
    if (name === 'id') return source.id ?? null;
    if (name === 'name') return source.name ?? null;
    if (name === 'email') return source.email ?? null;
    state.errors.push({ message: `Cannot query field '${name}' on type 'User'.` });
    return undefined;
  }

  // Repository.
  if (typeName === 'Repository') {
    const repo = source.__repo as Repo;
    if (name === 'owner') {
      const node = userNode(repo.owner);
      if (field.selections) return resolveSelections(ctx, state, 'User', node, field.selections, variables);
      return node;
    }
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      const node: Record<string, unknown> = { __typename: 'Ref', name: repo.defaultBranch };
      if (field.selections) return resolveSelections(ctx, state, 'Ref', node, field.selections, variables);
      return node;
    }
    if (name === 'issue') {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      if (!issue) return null;
      const node = issueNode(ctx, repo, issue);
      if (field.selections) return resolveSelections(ctx, state, 'Issue', node, field.selections, variables);
      return node;
    }
    if (name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const after = typeof args.after === 'string' ? args.after : null;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
      let issues = [...repo.issues.values()];
      if (states) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      if (after) {
        const cursorNum = numberFromCursor(after);
        if (cursorNum !== null) {
          issues = issues.filter((i) => (direction === 'ASC' ? i.number > cursorNum : i.number < cursorNum));
        }
      }
      const total = issues.length;
      const page = first !== undefined ? issues.slice(0, first) : issues;
      const hasNextPage = first !== undefined ? total > page.length : false;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
      const nodes = page.map((issue) => {
        const node = issueNode(ctx, repo, issue);
        if (field.selections) {
          const connSelections = field.selections;
          // The connection's `nodes` sub-selection lives under the `nodes` field.
          return node;
        }
        return node;
      });
      const conn: Record<string, unknown> = { __typename: 'IssueConnection', __repo: repo };
      if (field.selections) {
        // Resolve the connection fields (nodes, pageInfo) with their own selections.
        const out: Record<string, unknown> = {};
        for (const sub of field.selections) {
          if (sub.kind === 'inlineFragment') continue;
          if (sub.name === 'nodes') {
            out.nodes = nodes.map((n) => {
              if (sub.selections) return resolveSelections(ctx, state, 'Issue', n, sub.selections, variables);
              return n;
            });
          } else if (sub.name === 'pageInfo') {
            const pi: Record<string, unknown> = { __typename: 'PageInfo', hasNextPage, endCursor };
            if (sub.selections) {
              out.pageInfo = resolveSelections(ctx, state, 'PageInfo', pi, sub.selections, variables);
            } else {
              out.pageInfo = pi;
            }
          } else if (sub.name === 'totalCount') {
            out.totalCount = total;
          } else {
            state.errors.push({ message: `Cannot query field '${sub.name}' on type 'IssueConnection'.` });
          }
        }
        return out;
      }
      return { nodes, pageInfo: { hasNextPage, endCursor } };
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open');
      pulls.sort((a, b) => b.number - a.number);
      if (first !== undefined) pulls = pulls.slice(0, first);
      const nodes = pulls.map((p) => pullNode(ctx, repo, p));
      if (field.selections) {
        const out: Record<string, unknown> = {};
        for (const sub of field.selections) {
          if (sub.kind === 'inlineFragment') continue;
          if (sub.name === 'nodes') {
            out.nodes = nodes.map((n) => {
              if (sub.selections) return resolveSelections(ctx, state, 'PullRequest', n, sub.selections, variables);
              return n;
            });
          } else if (sub.name === 'totalCount') {
            out.totalCount = nodes.length;
          } else {
            state.errors.push({ message: `Cannot query field '${sub.name}' on type 'PullRequestConnection'.` });
          }
        }
        return out;
      }
      return { nodes };
    }
    if (name === 'pullRequest') {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      if (!pull) return null;
      const node = pullNode(ctx, repo, pull);
      if (field.selections) return resolveSelections(ctx, state, 'PullRequest', node, field.selections, variables);
      return node;
    }
    // Scalar repository fields.
    if (['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'viewerPermission', 'hasIssuesEnabled'].includes(name)) {
      return source[name] ?? null;
    }
    state.errors.push({ message: `Cannot query field '${name}' on type 'Repository'.` });
    return undefined;
  }

  // Issue.
  if (typeName === 'Issue') {
    if (['id', 'number', 'title', 'state', 'body'].includes(name)) return source[name] ?? null;
    if (name === 'labels') return [];
    if (name === 'comments') return { nodes: [] };
    state.errors.push({ message: `Cannot query field '${name}' on type 'Issue'.` });
    return undefined;
  }

  // PullRequest.
  if (typeName === 'PullRequest') {
    const repo = source.__repo as Repo;
    const pull = source.__pull as Pull;
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const files = pullFiles(repo, pull);
      let nodes = files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions }));
      if (first !== undefined) nodes = nodes.slice(0, first);
      if (field.selections) {
        const out: Record<string, unknown> = {};
        for (const sub of field.selections) {
          if (sub.kind === 'inlineFragment') continue;
          if (sub.name === 'nodes') {
            out.nodes = nodes.map((n) => {
              if (sub.selections) return resolveSelections(ctx, state, 'PullRequestChangedFile', n, sub.selections, variables);
              return n;
            });
          } else if (sub.name === 'totalCount') {
            out.totalCount = nodes.length;
          } else {
            state.errors.push({ message: `Cannot query field '${sub.name}' on type 'PullRequestChangedFileConnection'.` });
          }
        }
        return out;
      }
      return { nodes };
    }
    if (['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName'].includes(name)) {
      return source[name] ?? null;
    }
    state.errors.push({ message: `Cannot query field '${name}' on type 'PullRequest'.` });
    return undefined;
  }

  // IssueComment.
  if (typeName === 'IssueComment') {
    if (name === 'id') return source.id ?? null;
    if (name === 'body') return source.body ?? null;
    state.errors.push({ message: `Cannot query field '${name}' on type 'IssueComment'.` });
    return undefined;
  }

  // PullRequestChangedFile.
  if (typeName === 'PullRequestChangedFile') {
    if (['path', 'additions', 'deletions'].includes(name)) return source[name] ?? null;
    state.errors.push({ message: `Cannot query field '${name}' on type 'PullRequestChangedFile'.` });
    return undefined;
  }

  // Ref.
  if (typeName === 'Ref') {
    if (name === 'name') return source.name ?? null;
    state.errors.push({ message: `Cannot query field '${name}' on type 'Ref'.` });
    return undefined;
  }

  // PageInfo.
  if (typeName === 'PageInfo') {
    if (['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(name)) return source[name] ?? null;
    state.errors.push({ message: `Cannot query field '${name}' on type 'PageInfo'.` });
    return undefined;
  }

  state.errors.push({ message: `Cannot query field '${name}' on type '${typeName}'.` });
  return undefined;
}

// ------------------------------------------------------------------ mutations

function resolveMutation(
  ctx: GraphQLContext,
  state: ExecState,
  op: GqlOperation,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind === 'inlineFragment') continue;
    const field = sel;
    const responseKey = field.alias ?? field.name;
    const args = resolveArgs(field.args, variables);
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const parsed = parseGlobalId(repoId);
      let payload: Record<string, unknown> | null = null;
      if (parsed && parsed.type === 'Repository') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        if (repo) {
          const title = typeof input.title === 'string' ? input.title : '';
          const body = typeof input.body === 'string' ? input.body : '';
          const issue = ctx.store.createIssue(repo, title, body, []);
          const node = issueNode(ctx, repo, issue);
          const issueSel = field.selections?.find((s) => s.kind === 'field' && s.name === 'issue') as GqlField | undefined;
          payload = {
            issue: issueSel?.selections ? resolveSelections(ctx, state, 'Issue', node, issueSel.selections, variables) : node,
          };
        }
      }
      out[responseKey] = payload;
      continue;
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const parsed = parseGlobalId(issueId);
      let payload: Record<string, unknown> | null = null;
      if (parsed && parsed.type === 'Issue') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const issue = repo?.issues.get(parsed.number);
        if (repo && issue) {
          issue.state = 'closed';
          issue.updatedAt = isoNow();
          const node = issueNode(ctx, repo, issue);
          const issueSel = field.selections?.find((s) => s.kind === 'field' && s.name === 'issue') as GqlField | undefined;
          payload = {
            issue: issueSel?.selections ? resolveSelections(ctx, state, 'Issue', node, issueSel.selections, variables) : node,
          };
        }
      }
      out[responseKey] = payload;
      continue;
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const parsed = parseGlobalId(repoId);
      let payload: Record<string, unknown> | null = null;
      if (parsed && parsed.type === 'Repository') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        if (repo) {
          const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
          const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
          const title = typeof input.title === 'string' ? input.title : '';
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha && baseSha) {
            const tmpPull: Pull = {
              id: 0, number: 0, title, body: '', state: 'open', merged: false, mergedAt: null,
              mergeable: true, headRef, headSha, baseRef, baseSha, files: [], mergeCommitSha: null,
              createdAt: isoNow(), updatedAt: isoNow(),
            };
            const files = pullFiles(repo, tmpPull).map((f) => ({
              filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, sha: f.sha,
            }));
            const pull = ctx.store.createPull(repo, title, '', headRef, headSha, baseRef, baseSha, files);
            const node = pullNode(ctx, repo, pull);
            const prSel = field.selections?.find((s) => s.kind === 'field' && s.name === 'pullRequest') as GqlField | undefined;
            payload = {
              pullRequest: prSel?.selections ? resolveSelections(ctx, state, 'PullRequest', node, prSel.selections, variables) : node,
            };
          }
        }
      }
      out[responseKey] = payload;
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const parsed = parseGlobalId(prId);
      let payload: Record<string, unknown> | null = null;
      if (parsed && parsed.type === 'PullRequest') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const pull = repo?.pulls.get(parsed.number);
        if (repo && pull) {
          mergePull(ctx.store, repo, pull, ctx.viewerLogin);
          const node = pullNode(ctx, repo, pull);
          const prSel = field.selections?.find((s) => s.kind === 'field' && s.name === 'pullRequest') as GqlField | undefined;
          payload = {
            pullRequest: prSel?.selections ? resolveSelections(ctx, state, 'PullRequest', node, prSel.selections, variables) : node,
          };
        }
      }
      out[responseKey] = payload;
      continue;
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const parsed = parseGlobalId(subjectId);
      let payload: Record<string, unknown> | null = null;
      if (parsed && parsed.type === 'Issue') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const issue = repo?.issues.get(parsed.number);
        if (repo && issue) {
          const comment = { id: repo.nextComment++, body, createdAt: isoNow(), updatedAt: isoNow() };
          issue.comments.push(comment);
          const node: Record<string, unknown> = {
            __typename: 'IssueComment',
            id: commentGlobalId(repo, issue, comment.id),
            body: comment.body,
          };
          const edgeSel = field.selections?.find((s) => s.kind === 'field' && s.name === 'commentEdge') as GqlField | undefined;
          const nodeSel = edgeSel?.selections?.find((s) => s.kind === 'field' && s.name === 'node') as GqlField | undefined;
          const resolvedNode = nodeSel?.selections
            ? resolveSelections(ctx, state, 'IssueComment', node, nodeSel.selections, variables)
            : { id: node.id, body: node.body };
          payload = { commentEdge: { node: resolvedNode } };
        }
      }
      out[responseKey] = payload;
      continue;
    }
    state.errors.push({ message: `Cannot query field '${field.name}' on type 'Mutation'.` });
  }
  return out;
}

// ------------------------------------------------------------------ entry

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function executeOperation(
  ctx: GraphQLContext,
  op: GqlOperation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const state: ExecState = { errors: [] };
  let data: Record<string, unknown> | null;
  if (op.operationType === 'mutation') {
    data = resolveMutation(ctx, state, op, variables);
  } else {
    data = resolveSelections(ctx, state, 'Query', { __typename: 'Query' }, op.selections, variables);
  }
  return { data, errors: state.errors };
}

/**
 * Handle one POST /api/graphql body. The body may be a single operation
 * object ({query, variables}) or a JSON array of them (batching). Returns
 * the HTTP status and the JSON body (a single object or an array).
 */
export function handleGraphQL(ctx: GraphQLContext, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(ctx, entry));
    return { status: 200, body: results };
  }
  return { status: 200, body: executeOne(ctx, body) };
}

function executeOne(ctx: GraphQLContext, entry: unknown): Record<string, unknown> {
  const e = (entry ?? {}) as Record<string, unknown>;
  const query = typeof e.query === 'string' ? e.query : '';
  const variables = (e.variables ?? {}) as Record<string, unknown>;
  if (!query) {
    return { data: null, errors: [{ message: 'No query provided.' }] };
  }
  let ops: GqlOperation[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax error: ${(err as Error).message}` }] };
  }
  if (ops.length === 0) {
    return { data: null, errors: [{ message: 'No operation provided.' }] };
  }
  // If several operations are in one document, run them in order and merge
  // the data objects (the checks send one operation per document, or a
  // batch of separate documents).
  const merged: Record<string, unknown> = {};
  const allErrors: Array<{ message: string }> = [];
  for (const op of ops) {
    const { data, errors } = executeOperation(ctx, op, variables);
    if (data) Object.assign(merged, data);
    allErrors.push(...errors);
  }
  const result: Record<string, unknown> = { data: merged };
  if (allErrors.length > 0) result.errors = allErrors;
  return result;
}

export { VIEWER_LOGIN, VIEWER_ID };
