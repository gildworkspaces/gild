// The only code that talks HTTP to gild. Every request is built from the one repository the
// client was constructed for: there is no method that takes a path, so a session cannot reach
// another repository through it even if the token would allow it (gild's own allow-list on an
// agent token is the second line). Tokens travel only to the configured gild origin, and
// redirects are refused so an Authorization header is never carried off-origin.

import { createLogger } from "@gadgets/observability/logger";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { pushGitRefUpdate, ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";

export const VENDOR_ID = "gild";
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 << 20;

export const logger = createLogger<{
  vendorId: string; method: string; route: string; status: number; ms: number;
  repo: string; actionId: number; kind: string; agent: string;
}>({ component: "gatekeeper.gild", vendorId: VENDOR_ID });

/** An HTTP failure from gild, carrying the status for classification (401 vs 404 vs 409). */
export class GildApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Normalizes the configured gild origin: https only, except a local development forge. */
export function gildOrigin(value: string | undefined): string {
  const url = new URL(value ?? "https://gild.gg");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("GILD_URL must be an https origin.");
  }
  return url.origin;
}

export const REPO_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/i;

// --- the GitHub-shaped records gild's /api/v1 returns (fields this gatekeeper reads) ------------

export type ApiUser = { login: string };
export type ApiLabel = { name: string };
export type ApiRepo = {
  full_name: string; description: string | null; default_branch: string; private: boolean;
  html_url: string; stargazers_count: number;
};
export type ApiIssue = {
  number: number; title: string; body: string; user: ApiUser; state: "open" | "closed";
  labels: ApiLabel[]; comments: number; created_at: string; updated_at: string; html_url: string;
  pull_request?: unknown;
};
export type ApiComment = { id: number; user: ApiUser; body: string; created_at: string; html_url: string };
export type ApiPull = ApiIssue & {
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; draft: boolean; mergeable: boolean | null;
};
export type ApiFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
export type ApiReview = { user: ApiUser; body: string; state: string; submitted_at: string };
export type ApiBranch = { name: string; commit: { sha: string } };
export type ApiCommit = {
  sha: string; html_url: string;
  commit: { message: string; author: { name: string; email: string; date: string }; tree: { sha: string } };
  parents: { sha: string }[];
};
export type ApiContent = {
  type: "file" | "dir" | "symlink" | "submodule"; name: string; path: string; sha: string;
  size: number; encoding?: string; content?: string;
};
export type ApiTree = { sha: string; tree: { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string }[] };
export type ApiHealth = {
  lines: number;
  scores: { quality: number; containment: number; legibility: number; security: number; modularity: number } | null;
  incomplete?: string;
};
export type ApiChannelMessage = {
  cursor: string; created_at: string; author: { name: string; kind: "human" | "agent" };
  kind: "message" | "system"; body: string; reply_to: string | null; link: { href: string; label: string } | null;
};
export type ApiChannelPage = { messages: ApiChannelMessage[]; cursor: string; before: string | null; after: string | null };

/** What a connected gild agent holds: its token, its name, and the one repository it may use. */
export type GildCredentials = { origin: string; token: string; agent: string; repo: string };

export class GildApi {
  readonly #creds: GildCredentials;
  readonly #fetch: typeof fetch;
  readonly owner: string;
  readonly name: string;

  constructor(creds: GildCredentials, fetcher: typeof fetch = (...a) => fetch(...a)) {
    if (!REPO_RE.test(creds.repo)) throw new Error("A gild connection names one repository as owner/name.");
    this.#creds = creds;
    this.#fetch = fetcher;
    [this.owner, this.name] = creds.repo.split("/") as [string, string];
  }

  get repo(): string {
    return this.#creds.repo;
  }

  get agent(): string {
    return this.#creds.agent;
  }

  /** The repository's page on gild, for links in results. */
  webUrl(suffix = ""): string {
    return `${this.#creds.origin}/${this.#creds.repo}${suffix}`;
  }

  async #request<T>(method: string, route: string, init: {
    query?: Record<string, string | number | undefined>; json?: unknown; headers?: Record<string, string>;
  } = {}): Promise<T> {
    const url = new URL(`${this.#creds.origin}/api/v1/repos/${this.#creds.repo}${route}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const started = Date.now();
    const response = await this.#fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.#creds.token}`,
        accept: "application/json",
        "user-agent": "gild-gatekeeper (Cloudflare OS)",
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    logger.info("gild request", {
      event: "gild.request", method, route: route.replace(/\/[^/]*$/, m => /\d/.test(m) ? "/:id" : m),
      status: response.status, ms: Date.now() - started, repo: this.#creds.repo,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new GildApiError(response.status, `gild redirected ${route}; refusing to follow it with the token.`);
    }
    const text = await readTextCapped(response, MAX_BODY_BYTES);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        message = String(parsed.message ?? parsed.error ?? message).slice(0, 300);
      } catch {}
      throw new GildApiError(response.status, `gild ${method} ${route}: ${message}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  // --- reads -----------------------------------------------------------------------------------

  repository(): Promise<ApiRepo> {
    return this.#request("GET", "");
  }

  branches(): Promise<ApiBranch[]> {
    return this.#request("GET", "/branches", { query: { per_page: 100 } });
  }

  /** The commit a branch points at, or null when the branch does not exist. */
  async branchHead(branch: string): Promise<string | null> {
    try {
      const ref = await this.#request<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodePath(branch)}`);
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GildApiError && error.status === 404) return null;
      throw error;
    }
  }

  commit(ref: string): Promise<ApiCommit> {
    return this.#request("GET", `/commits/${encodeURIComponent(ref)}`);
  }

  commits(ref: string | undefined, perPage: number): Promise<ApiCommit[]> {
    return this.#request("GET", "/commits", { query: { sha: ref, per_page: perPage } });
  }

  /** A file or directory listing at `ref`; null when the path does not exist there. */
  async contents(path: string, ref?: string): Promise<ApiContent | ApiContent[] | null> {
    try {
      return await this.#request("GET", path ? `/contents/${encodePath(path)}` : "/contents", { query: { ref } });
    } catch (error) {
      if (error instanceof GildApiError && error.status === 404) return null;
      throw error;
    }
  }

  tree(sha: string): Promise<ApiTree> {
    return this.#request("GET", `/git/trees/${encodeURIComponent(sha)}`);
  }

  issues(state: "open" | "closed" | "all", perPage: number): Promise<ApiIssue[]> {
    return this.#request("GET", "/issues", { query: { state, per_page: perPage } });
  }

  issue(number: number): Promise<ApiIssue> {
    return this.#request("GET", `/issues/${number}`);
  }

  issueComments(number: number): Promise<ApiComment[]> {
    return this.#request("GET", `/issues/${number}/comments`, { query: { per_page: 100 } });
  }

  pulls(state: "open" | "closed" | "all", perPage: number): Promise<ApiPull[]> {
    return this.#request("GET", "/pulls", { query: { state, per_page: perPage } });
  }

  pull(number: number): Promise<ApiPull> {
    return this.#request("GET", `/pulls/${number}`);
  }

  pullFiles(number: number): Promise<ApiFile[]> {
    return this.#request("GET", `/pulls/${number}/files`, { query: { per_page: 100 } });
  }

  pullReviews(number: number): Promise<ApiReview[]> {
    return this.#request("GET", `/pulls/${number}/reviews`);
  }

  /** gild's cqx code score at a ref; null while it is still being computed or unavailable. */
  async health(ref?: string): Promise<ApiHealth | null> {
    try {
      return await this.#request("GET", "/health", { query: { ref } });
    } catch (error) {
      if (error instanceof GildApiError && [404, 409, 422, 503].includes(error.status)) return null;
      throw error;
    }
  }

  channel(query: { before?: string; limit: number }): Promise<ApiChannelPage> {
    return this.#request("GET", "/channel/messages", { query });
  }

  // --- writes: called only from approved actions --------------------------------------------

  createIssue(input: { title: string; body: string; labels: string[] }): Promise<ApiIssue> {
    return this.#request("POST", "/issues", { json: input });
  }

  updateIssue(number: number, input: { title?: string; body?: string; state?: "open" | "closed" }): Promise<ApiIssue> {
    return this.#request("PATCH", `/issues/${number}`, { json: input });
  }

  comment(number: number, body: string): Promise<ApiComment> {
    return this.#request("POST", `/issues/${number}/comments`, { json: { body } });
  }

  createPull(input: { title: string; body: string; head: string; base: string }): Promise<ApiPull> {
    return this.#request("POST", "/pulls", { json: input });
  }

  /** Posts to the repository channel. The key makes a retried apply a replay, not a duplicate. */
  postChannel(body: string, idempotencyKey: string): Promise<ApiChannelMessage> {
    return this.#request("POST", "/channel/messages", { json: { body }, headers: { "idempotency-key": idempotencyKey } });
  }

  /**
   * Moves `branch` from `oldSha` (ZERO_OID to create it) to `newSha` with a receive-pack carrying
   * `pack`. receive-pack's compare-and-swap refuses the update if the branch moved meanwhile.
   */
  async pushBranch(branch: string, oldSha: string, newSha: string, pack: Uint8Array): Promise<void> {
    const url = `${this.#creds.origin}/${this.#creds.repo}.git/git-receive-pack`;
    const started = Date.now();
    await pushGitRefUpdate(async body => {
      const response = await this.#fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.#creds.token}`,
          "content-type": "application/x-git-receive-pack-request",
          accept: "application/x-git-receive-pack-result",
          "user-agent": "git/2.50 gild-gatekeeper",
        },
        body: await new Response(body).arrayBuffer(),
      });
      logger.info("gild push", {
        event: "gild.push", method: "POST", route: "/git-receive-pack", status: response.status,
        ms: Date.now() - started, repo: this.#creds.repo,
      });
      if (!response.ok) {
        const text = await readTextCapped(response, 4096).catch(() => "");
        throw new GildApiError(response.status, `gild refused the push: ${text.slice(0, 300) || `HTTP ${response.status}`}`);
      }
      return response;
    }, { branch, oldSha: oldSha || ZERO_OID, newSha }, new Blob([pack]).stream());
  }
}

/** Encodes each path segment, keeping the slashes the route expects. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
