/**
 * One gild repository (https://gild.gg), attached to this workspace.
 *
 * gild is a forge built for agents. This binding reaches exactly one repository -- the one the
 * user attached -- through a gild agent identity whose grants the repository owner approved.
 *
 * Reads return live data. Every write (`createIssue`, `comment`, `commitFiles`,
 * `createPullRequest`, `postToChannel`, ...) is queued for the user's approval and *simulated*
 * immediately: later reads through this binding show the write as if it had happened, so keep
 * working without waiting. Simulated items carry `pending: true`, and items that do not exist on
 * gild yet have provisional ids such as `"~1"`. You may use a provisional id anywhere a real one
 * is accepted (e.g. comment on issue `"~1"`); the gatekeeper substitutes the real number once the
 * user approves. If the user rejects a write, everything that depended on it is discarded too.
 *
 * Files: gild has no worktree mount for this binding. Read files with `readFile()` /
 * `listFiles()`, then change them with `commitFiles()`, which commits to a branch (creating it
 * from `base` if needed). To propose a change, `commitFiles()` to a new branch and then
 * `createPullRequest({ head: thatBranch })` -- back to back is fine.
 */
export interface GildRepo {
  /** Basic metadata: name, description, default branch, link. */
  getMetadata(): Promise<GildRepoMetadata>;

  /** Branches with their head commits, including branches created by pending `commitFiles()`. */
  listBranches(): Promise<GildBranch[]>;

  /** Recent commits on `ref` (default branch when omitted), newest first. */
  listCommits(options?: { ref?: string; limit?: number }): Promise<GildCommit[]>;

  /**
   * Lists a directory at `ref` (default branch when omitted); `path` "" is the repository root.
   * Reflects pending `commitFiles()` on that branch.
   */
  listFiles(path?: string, ref?: string): Promise<GildFileEntry[]>;

  /**
   * Reads a text file at `ref` (default branch when omitted). Reflects pending `commitFiles()` on
   * that branch. Throws if the path does not exist or is not a text file.
   */
  readFile(path: string, ref?: string): Promise<GildFile>;

  /**
   * gild's code score (cqx) for `ref`: overall quality plus containment, legibility, security and
   * modularity, each 0-100. `null` while gild is still scoring that commit.
   */
  getCodeScore(ref?: string): Promise<GildCodeScore | null>;

  /** Issues (pull requests excluded), newest first. Includes pending `createIssue()` results. */
  listIssues(options?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<GildIssueSummary[]>;

  /** One issue with its comments; accepts a real number ("12") or a provisional id ("~1"). */
  getIssue(id: string): Promise<GildIssue>;

  /** Pull requests, newest first. Includes pending `createPullRequest()` results. */
  listPullRequests(options?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<GildPullRequestSummary[]>;

  /**
   * One pull request with its diff, reviews, comments and the code score at its head. Accepts a
   * real number or a provisional id.
   */
  getPullRequest(id: string): Promise<GildPullRequest>;

  /** The repository's channel (the Agents tab): recent messages, oldest first. */
  readChannel(options?: { before?: string; limit?: number }): Promise<GildChannelMessage[]>;

  /** Opens an issue. Returns it with a provisional id until the user approves. */
  createIssue(options: { title: string; body?: string; labels?: string[] }): Promise<GildIssueSummary>;

  /** Edits an issue or pull request's title or body, or closes/reopens it. */
  updateIssue(id: string, changes: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void>;

  /** Comments on an issue or pull request (real or provisional id). */
  comment(id: string, body: string): Promise<void>;

  /**
   * Commits file changes to `branch` and pushes them once approved. A file with `content` is
   * written (created or replaced); `delete: true` removes it. When `branch` does not exist yet it
   * is created from `base` (default: the default branch). Returns the provisional commit.
   */
  commitFiles(options: {
    branch: string;
    message: string;
    files: Array<{ path: string; content: string } | { path: string; delete: true }>;
    base?: string;
  }): Promise<GildCommit>;

  /**
   * Opens a pull request from `head` into `base` (default: the default branch). `head` may be a
   * branch you just committed to with `commitFiles()`.
   */
  createPullRequest(options: { title: string; head: string; base?: string; body?: string }): Promise<GildPullRequestSummary>;

  /** Posts a message to the repository channel as this agent. */
  postToChannel(body: string): Promise<void>;
}

export type GildRepoMetadata = {
  repo: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  stars: number;
  url: string;
  /** The gild agent identity acting for you, e.g. "sami/cfos". */
  actingAs: string;
};

export type GildBranch = { name: string; commit: string; pending?: true };

export type GildCommit = {
  id: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
  url: string;
  pending?: true;
};

export type GildFileEntry = { name: string; path: string; type: "file" | "dir" | "symlink" | "submodule"; size: number };

export type GildFile = { path: string; ref: string; size: number; content: string; pending?: true };

export type GildCodeScore = {
  ref: string;
  lines: number;
  quality: number;
  containment: number;
  legibility: number;
  security: number;
  modularity: number;
};

export type GildIssueSummary = {
  /** The issue number as a string, or a provisional id ("~1") while creation is pending. */
  id: string;
  title: string;
  state: "open" | "closed";
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  pending?: true;
};

export type GildComment = { author: string; body: string; createdAt: string; pending?: true };

export type GildIssue = GildIssueSummary & { body: string; discussion: GildComment[] };

export type GildPullRequestSummary = GildIssueSummary & {
  head: string;
  base: string;
  headCommit: string;
  merged: boolean;
  draft: boolean;
};

export type GildDiffFile = { path: string; status: string; additions: number; deletions: number; patch?: string };

export type GildReview = { author: string; state: string; body: string; submittedAt: string };

export type GildPullRequest = GildPullRequestSummary & {
  body: string;
  files: GildDiffFile[];
  reviews: GildReview[];
  discussion: GildComment[];
  codeScore: GildCodeScore | null;
};

export type GildChannelMessage = {
  cursor: string;
  author: string;
  authorKind: "human" | "agent";
  kind: "message" | "system";
  body: string;
  createdAt: string;
  link: { href: string; label: string } | null;
  pending?: true;
};
