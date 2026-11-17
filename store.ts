// In-memory store for the forge: repositories, git objects, issues, pull
// requests, labels and comments. Everything lives in Maps; nothing touches
// the disk during a trial, which keeps the timed workloads fast. A trial
// runs in one fresh process, so persistence is never needed.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  sha: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeable: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  files: PullFile[];
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  // Cache of generated packs, keyed by a description of the fetch. A
  // shallow clone of one tip always builds the same bytes, so the 50
  // concurrent clones in the benchmark share one cached pack.
  packCache: Map<string, Buffer>;
}

let nextRepoId = 5000;
let nextGlobalId = 100000;

export function nextId(): number {
  nextGlobalId += 1;
  return nextGlobalId;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export class Store {
  readonly repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string } = {}): Repo {
    const now = isoNow();
    const repo: Repo = {
      id: nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      packCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => (a.id - b.id));
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = isoNow();
    const number = repo.nextIssue++;
    const issue: Issue = {
      id: nextId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string, files: PullFile[]): Pull {
    const now = isoNow();
    const number = repo.nextPull++;
    const pull: Pull = {
      id: nextId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeable: true,
      headRef,
      headSha,
      baseRef,
      baseSha,
      files,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  renameRepo(repo: Repo, newName: string): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    repo.name = newName;
    repo.fullName = `${repo.owner}/${newName}`;
    this.repos.set(this.repoKey(repo.owner, newName), repo);
  }
}
