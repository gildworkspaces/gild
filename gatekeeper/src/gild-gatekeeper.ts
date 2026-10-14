// The per-binding gatekeeper: a Durable Object facet the overseer installs for one attached gild
// repository. It owns the action journal (kit `defineActions`), the simulation that projects
// pending writes onto reads, and the apply handlers that are the only callers of gild's write
// endpoints. Sessions (gild-session.ts) hold this object in-process and authorize every read
// through their ObservationGate before returning it.

import { DurableObject, RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  GitCache,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionApplyError,
  ActionJournal,
  ActionOutcomeUnknownError,
  defineActions,
  type ActionSubmitter,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { aclObservers } from "@gadgets/gatekeeper-kit/observers";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { GitRefUpdateRejectedError, validateBranchName, ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import {
  GildApi, GildApiError, logger, VENDOR_ID,
  type ApiChannelMessage, type ApiComment, type ApiCommit, type ApiContent, type ApiHealth,
  type ApiIssue, type ApiPull,
} from "./gild-api";
import { buildPack, editTree, encodeCommit, validatePath, type FileChange } from "./git-pack";
import { GildRepoSession } from "./gild-session";
import type {
  GildBranch, GildChannelMessage, GildCodeScore, GildComment, GildCommit, GildFile, GildFileEntry,
  GildIssue, GildIssueSummary, GildPullRequest, GildPullRequestSummary, GildRepoMetadata,
} from "./types";
import TYPES_CODE from "./types.txt";

/** Props the account mints the facet class with: which account, and the one repository. */
export type GildGatekeeperProps = { userObjectId: string; repo: string };

/** The verifier a collaborator's account mints (`GildVerifier` in gild.ts). */
export interface GildVerifierApi extends GatekeeperUserVerifier {
  canReadRepo(repo: string): Promise<boolean>;
}

/** What the account hands a facet: credentials plus the connection generation actions pin. */
export type AccountCredentials = {
  origin: string; token: string; agent: string; repo: string; generation: string;
};

/** The account surface a facet calls; implemented by `UserAccount` in gild.ts. */
export type AccountStub = { credentials(): Promise<AccountCredentials> };

// --- actions ---------------------------------------------------------------------------------

export type GildActions = {
  createIssue: { ref: string; title: string; body: string; labels: string[] };
  updateIssue: { target: string; title?: string; body?: string; state?: "open" | "closed" };
  comment: { target: string; body: string };
  commitFiles: {
    ref: string; branch: string; base: string; createsBranch: boolean; message: string;
    files: FileChange[]; seconds: number;
  };
  createPullRequest: { ref: string; title: string; body: string; head: string; base: string; after?: string };
  postToChannel: { body: string };
};
export type GildAction = TaggedAction<GildActions>;

/** What apply handlers may do: reach gild, and bind provisional ids. Not the Durable Object. */
type Host = {
  api(): Promise<{ api: GildApi; generation: string }>;
  items: ProvisionalIds<string>;
  commits: ProvisionalIds<string>;
  /** A stable key per binding, for channel post idempotency. */
  bindingKey: string;
};

const isProvisional = (id: string) => id.startsWith("~");
const isCommitRef = (id: string) => id.startsWith("~c");

function resolveRef(host: Host, ref: string): string {
  return isCommitRef(ref) ? host.commits.requireResolved(ref) : host.items.requireResolved(ref);
}

/** A handler must not run under a connection replaced after apply's entry check. */
async function fenced(host: Host, fence: { generation: string } | undefined): Promise<GildApi> {
  const { api, generation } = await host.api();
  if (fence && fence.generation !== generation) {
    throw new ActionApplyError("This action was approved under a gild connection that has since been replaced. Reject it and submit it again.");
  }
  return api;
}

/** A write whose request reached gild but whose answer was lost may have landed. */
function classifyWriteError(error: unknown): never {
  if (error instanceof GildApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    // gild refused it: nothing landed, and retrying the same request will be refused again.
    throw new ActionApplyError(error.message);
  }
  if (error instanceof GildApiError) throw error;
  throw new ActionOutcomeUnknownError(
    `gild did not confirm this write (${error instanceof Error ? error.message : String(error)}); check the repository before submitting it again.`);
}

const actions = defineActions<Host, GildActions>({
  createIssue: {
    kind: { tag: "gild.create-issue", label: "Open a gild issue" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: p => ({
      title: "Open an issue on gild",
      ...buildDescription("Opens a new issue in the attached gild repository.")
        .inline("Title", p.title).verbatim("Body", p.body, "markdown").list("Labels", p.labels).finish(),
      implementsRevert: false,
    }),
    provides: p => [p.ref],
    apply: async (p, host, { fence }) => {
      const api = await fenced(host, fence);
      const issue = await api.createIssue({ title: p.title, body: p.body, labels: p.labels }).catch(classifyWriteError);
      host.items.bind(p.ref, String(issue.number));
    },
  },
  updateIssue: {
    kind: { tag: "gild.update-issue", label: "Edit a gild issue or pull request" },
    delivery: "continue-with-simulation",
    describe: p => {
      const d = buildDescription("Edits an issue or pull request in the attached gild repository.").inline("Item", p.target);
      if (p.title !== undefined) d.inline("New title", p.title);
      if (p.body !== undefined) d.verbatim("New body", p.body, "markdown");
      if (p.state !== undefined) d.inline("New state", p.state);
      return { title: `Edit #${p.target} on gild`, ...d.finish(), implementsRevert: false };
    },
    dependsOn: p => isProvisional(p.target) ? [p.target] : [],
    apply: async (p, host, { fence }) => {
      const api = await fenced(host, fence);
      const { target: _t, ...changes } = p;
      await api.updateIssue(Number(resolveRef(host, p.target)), changes).catch(classifyWriteError);
    },
  },
  comment: {
    kind: { tag: "gild.comment", label: "Comment on gild" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: p => ({
      title: `Comment on #${p.target} on gild`,
      ...buildDescription("Posts a comment on an issue or pull request in the attached gild repository.")
        .inline("Item", p.target).verbatim("Comment", p.body, "markdown").finish(),
      implementsRevert: false,
    }),
    dependsOn: p => isProvisional(p.target) ? [p.target] : [],
    apply: async (p, host, { fence }) => {
      const api = await fenced(host, fence);
      await api.comment(Number(resolveRef(host, p.target)), p.body).catch(classifyWriteError);
    },
  },
  commitFiles: {
    kind: { tag: "gild.push", label: "Push a commit to gild" },
    delivery: "continue-with-simulation",
    describe: p => {
      const d = buildDescription(p.createsBranch
        ? "Creates a branch in the attached gild repository with one new commit."
        : "Pushes one new commit to a branch of the attached gild repository.")
        .inline("Branch", p.branch).inline("Based on", p.base).verbatim("Commit message", p.message);
      for (const file of p.files) {
        if (file.content === null) d.inline("Delete", file.path);
        else d.verbatim(file.path, file.content);
      }
      return { title: `Push ${p.files.length} file change${p.files.length === 1 ? "" : "s"} to ${p.branch} on gild`, ...d.finish(), implementsRevert: false };
    },
    provides: p => [p.ref],
    dependsOn: p => isProvisional(p.base) ? [p.base] : [],
    // Idempotent without a claim: the commit hashes the same on every attempt (its timestamp is
    // fixed at submit), so a replay finds the branch already at it and only re-binds the ref.
    apply: async (p, host, { fence }) => {
      const api = await fenced(host, fence);
      const base = resolveRef(host, p.base);
      const parent = await api.commit(base);
      const { root, objects } = await editTree(
        async sha => (await api.tree(sha)).tree.map(e => ({ name: e.path, mode: e.mode, type: e.type, sha: e.sha })),
        parent.commit.tree.sha, p.files);
      const commit = await encodeCommit({
        tree: root, parents: [base], message: p.message,
        author: { name: api.agent, email: `${api.agent.replace("/", "+")}@agents.gild.gg`, seconds: p.seconds },
      });
      const head = await api.branchHead(p.branch);
      if (head === commit.oid) {
        host.commits.bind(p.ref, commit.oid);
        return;
      }
      const expected = p.createsBranch ? null : base;
      if (head !== expected) {
        throw new ActionApplyError(p.createsBranch
          ? `Branch ${p.branch} was created on gild by someone else meanwhile; nothing was pushed.`
          : `Branch ${p.branch} moved on gild since this commit was prepared; nothing was pushed.`);
      }
      try {
        await api.pushBranch(p.branch, head ?? ZERO_OID, commit.oid, await buildPack([...objects, commit]));
      } catch (error) {
        if (error instanceof GitRefUpdateRejectedError) {
          throw new ActionApplyError(`gild refused moving ${p.branch} (${error.message}); nothing was pushed.`);
        }
        if (error instanceof GildApiError && error.status >= 400 && error.status < 500) throw new ActionApplyError(error.message);
        // The compare-and-swap makes a retry safe: it lands, or finds the branch at this commit.
        throw error;
      }
      host.commits.bind(p.ref, commit.oid);
    },
  },
  createPullRequest: {
    kind: { tag: "gild.create-pull", label: "Open a gild pull request" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: p => ({
      title: `Open a pull request ${p.head} → ${p.base} on gild`,
      ...buildDescription("Opens a pull request in the attached gild repository.")
        .inline("Title", p.title).inline("From branch", p.head).inline("Into branch", p.base)
        .verbatim("Body", p.body, "markdown").finish(),
      implementsRevert: false,
    }),
    provides: p => [p.ref],
    dependsOn: p => p.after ? [p.after] : [],
    apply: async (p, host, { fence }) => {
      const api = await fenced(host, fence);
      const pull = await api.createPull({ title: p.title, body: p.body, head: p.head, base: p.base }).catch(classifyWriteError);
      host.items.bind(p.ref, String(pull.number));
    },
  },
  postToChannel: {
    kind: { tag: "gild.channel-post", label: "Post to the gild channel" },
    delivery: "continue-with-simulation",
    describe: p => ({
      title: "Post to the gild channel",
      ...buildDescription("Posts a message to the attached repository's channel (its Agents tab).")
        .verbatim("Message", p.body).finish(),
      implementsRevert: false,
    }),
    // Retried applies replay through gild's Idempotency-Key instead of posting twice.
    apply: async (p, host, { fence, id }) => {
      const api = await fenced(host, fence);
      await api.postChannel(p.body, `cfos:${host.bindingKey}:${id}`).catch(classifyWriteError);
    },
  },
}, {
  fence: "authority",
  isResolvedReference: (host, ref) => isCommitRef(ref) ? host.commits.isResolved(ref) : host.items.isResolved(ref),
  vendorId: VENDOR_ID,
});

// --- mapping gild records to the session types ---------------------------------------------

function issueSummary(api: GildApi, i: ApiIssue): GildIssueSummary {
  return {
    id: String(i.number), title: i.title, state: i.state, author: i.user.login,
    labels: i.labels.map(l => l.name), comments: i.comments, createdAt: i.created_at,
    updatedAt: i.updated_at, url: i.html_url || api.webUrl(`/issues/${i.number}`),
  };
}

function pullSummary(api: GildApi, p: ApiPull): GildPullRequestSummary {
  return {
    ...issueSummary(api, p), url: p.html_url || api.webUrl(`/pulls/${p.number}`),
    head: p.head.ref, base: p.base.ref, headCommit: p.head.sha, merged: p.merged, draft: p.draft,
  };
}

function commitSummary(c: ApiCommit): GildCommit {
  return {
    id: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date,
    parents: c.parents.map(p => p.sha), url: c.html_url,
  };
}

function commentOf(c: ApiComment): GildComment {
  return { author: c.user.login, body: c.body, createdAt: c.created_at };
}

function scoreOf(ref: string, h: ApiHealth | null): GildCodeScore | null {
  if (!h?.scores) return null;
  return { ref, lines: h.lines, ...h.scores };
}

function channelOf(m: ApiChannelMessage): GildChannelMessage {
  return {
    cursor: m.cursor, author: m.author.name, authorKind: m.author.kind, kind: m.kind, body: m.body,
    createdAt: m.created_at, link: m.link,
  };
}

function decodeBase64Text(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), c => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function limitOf(limit: number | undefined, fallback = 30): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer.");
  return Math.min(limit, 100);
}

// --- the facet -------------------------------------------------------------------------------

export class GildGatekeeperImpl extends DurableObject<Cloudflare.Env, GildGatekeeperProps>
  implements Gatekeeper<GildRepoSession> {

  readonly #journal = new ActionJournal<GildAction>(this.ctx.storage.kv, { namespace: "gild" });
  readonly #items = new ProvisionalIds<string>(this.ctx.storage.kv, { namespace: "items", isProvisional });
  readonly #commits = new ProvisionalIds<string>(this.ctx.storage.kv, { namespace: "commits", isProvisional });
  readonly #host: Host = {
    api: () => this.#api(),
    items: this.#items,
    commits: this.#commits,
    bindingKey: this.ctx.id.toString(),
  };
  readonly #actions = actions.bind(this.#journal, this.#host);
  /** Observers are admitted if their own gild identity can read this repository. */
  readonly observers = aclObservers<Fetcher<GildVerifierApi>>({
    hasAccess: verifier => verifier.canReadRepo(this.#repo()),
    denyMessage: "This collaborator's gild identity cannot read the attached repository.",
  });
  #defaultBranch?: string;

  #props(): GildGatekeeperProps {
    const props = this.ctx.props;
    if (!props || typeof props.repo !== "string" || typeof props.userObjectId !== "string") {
      throw new Error("This gild connection is missing its repository. Remove it and attach the repository again.");
    }
    return props;
  }

  #repo(): string {
    return this.#props().repo;
  }

  #account(): AccountStub {
    const ns = this.ctx.exports.UserAccount as unknown as DurableObjectNamespace;
    return ns.get(ns.idFromString(this.#props().userObjectId)) as unknown as AccountStub;
  }

  /**
   * A client for exactly the attached repository. The account's credentials name the one repo the
   * gild token is scoped to; if that ever differs from this binding's repo (a reconnect to another
   * repository), the binding refuses rather than reading or writing the other one.
   */
  async #api(): Promise<{ api: GildApi; generation: string }> {
    const creds = await this.#account().credentials();
    if (creds.repo.toLowerCase() !== this.#repo().toLowerCase()) {
      throw new Error(`This binding is for ${this.#repo()}, but the gild connection is now scoped to ${creds.repo}. Attach that repository instead.`);
    }
    return { api: new GildApi({ origin: creds.origin, token: creds.token, agent: creds.agent, repo: this.#repo() }), generation: creds.generation };
  }

  async api(): Promise<GildApi> {
    return (await this.#api()).api;
  }

  async #defaultBranchName(api: GildApi): Promise<string> {
    return this.#defaultBranch ??= (await api.repository()).default_branch;
  }

  #pending(): GildAction[] {
    return this.#journal.listPending().map(entry => entry.action);
  }

  // -- Gatekeeper interface -------------------------------------------------------------------

  async describe(): Promise<ResourceDescription> {
    const api = await this.api();
    const repo = await api.repository();
    return {
      url: api.webUrl(),
      title: repo.full_name,
      snippet: repo.description ?? `gild repository ${repo.full_name}`,
      suggestedBindingName: "GILD_REPO",
      tsType: "GildRepo",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GildRepoSession> {
    return new GildRepoSession(this, approvalQueue.dup());
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.observers.addObserver(id, user);
  }

  async removeObserver(id: string): Promise<void> {
    await this.observers.removeObserver(id);
  }

  async applyAction(action: number, _cache?: RpcStub<GitCache>): Promise<void> {
    const { generation } = await this.#api();
    const record = this.#journal.get(action);
    logger.info("gild action apply", { event: "gild.action.apply", actionId: action, kind: String(record?.action.kind ?? "?"), repo: this.#repo() });
    await this.#actions.apply(action, { generation });
  }

  async rejectAction(action: number): Promise<void | { restart?: boolean }> {
    const record = this.#journal.get(action);
    logger.info("gild action reject", { event: "gild.action.reject", actionId: action, kind: String(record?.action.kind ?? "?"), repo: this.#repo() });
    await this.#actions.reject(action);
  }

  async revertAction(_action: number): Promise<{ message: string }> {
    return { message: "gild actions are not reverted automatically. Close the issue or pull request, or push a revert commit, on gild." };
  }

  // -- staging (called by sessions) -----------------------------------------------------------

  async submit<K extends keyof GildActions>(queue: ActionSubmitter, kind: K, payload: GildActions[K]): Promise<number> {
    const { generation } = await this.#api();
    const id = await this.#actions.submit(queue, kind, payload, { fence: { generation } });
    logger.info("gild action queued", { event: "gild.action.submit", actionId: id, kind: String(kind), repo: this.#repo() });
    return id;
  }

  /** A provisional issue/PR id, as `createIssue`/`createPullRequest` hand back. */
  allocateItem(): string {
    return this.#items.allocate(n => `~${n}`);
  }

  allocateCommit(): string {
    return this.#commits.allocate(n => `~c${n}`);
  }

  /** The newest pending commit on `branch`, which a later commit or pull request builds on. */
  pendingHead(branch: string): string | null {
    let head: string | null = null;
    for (const a of this.#pending()) {
      if (a.kind === "commitFiles" && a.payload.branch === branch && !this.#commits.isResolved(a.payload.ref)) head = a.payload.ref;
    }
    return head;
  }

  /** Prepares a commitFiles payload: where it starts, and whether it creates the branch. */
  async prepareCommit(options: { branch: string; message: string; files: FileChange[]; base?: string }):
      Promise<GildActions["commitFiles"]> {
    validateBranchName(options.branch);
    if (!options.message.trim()) throw new Error("A commit needs a message.");
    if (options.files.length === 0) throw new Error("A commit needs at least one file change.");
    for (const f of options.files) validatePath(f.path);
    if (new Set(options.files.map(f => f.path)).size !== options.files.length) throw new Error("Each path may appear once per commit.");
    const api = await this.api();
    const pending = this.pendingHead(options.branch);
    let base: string, createsBranch = false;
    if (pending) {
      base = this.#commits.isResolved(pending) ? this.#commits.resolve(pending) : pending;
    } else {
      const head = await api.branchHead(options.branch);
      if (head) base = head;
      else {
        createsBranch = true;
        const from = options.base ?? await this.#defaultBranchName(api);
        const fromPending = this.pendingHead(from);
        base = fromPending ?? (await api.branchHead(from)) ?? (/^[0-9a-f]{40}$/.test(from) ? from : "");
        if (!base) throw new Error(`There is no branch ${from} to start ${options.branch} from.`);
      }
    }
    return {
      ref: this.allocateCommit(), branch: options.branch, base, createsBranch, message: options.message,
      files: options.files, seconds: Math.floor(Date.now() / 1000),
    };
  }

  // -- reads, with pending writes projected on top --------------------------------------------

  async metadata(): Promise<GildRepoMetadata> {
    const api = await this.api();
    const r = await api.repository();
    this.#defaultBranch = r.default_branch;
    return {
      repo: r.full_name, description: r.description, defaultBranch: r.default_branch, private: r.private,
      stars: r.stargazers_count, url: api.webUrl(), actingAs: api.agent,
    };
  }

  async branches(): Promise<GildBranch[]> {
    const api = await this.api();
    const branches = new Map<string, GildBranch>((await api.branches()).map(b => [b.name, { name: b.name, commit: b.commit.sha }]));
    for (const a of this.#pending()) {
      if (a.kind === "commitFiles") branches.set(a.payload.branch, { name: a.payload.branch, commit: a.payload.ref, pending: true });
    }
    return [...branches.values()];
  }

  /** The pending commits on a branch, oldest first, and the real ref gild should be read at. */
  async #branchView(api: GildApi, ref: string | undefined) {
    const branch = ref ?? await this.#defaultBranchName(api);
    const commits = this.#pending().filter((a): a is Extract<GildAction, { kind: "commitFiles" }> =>
      a.kind === "commitFiles" && a.payload.branch === branch);
    let readAt = branch;
    if (commits.length > 0) {
      // Read gild at the first pending commit's base; later pending commits chain on it.
      let base = commits[0]!.payload.base;
      while (isProvisional(base) && !this.#commits.isResolved(base)) {
        const providing = this.#pending().find(a => a.kind === "commitFiles" && a.payload.ref === base);
        if (!providing || providing.kind !== "commitFiles") break;
        commits.unshift(providing);
        base = providing.payload.base;
      }
      readAt = isProvisional(base) ? this.#commits.resolve(base) : base;
    }
    return { branch, commits, readAt };
  }

  async listCommits(ref: string | undefined, limit: number | undefined): Promise<GildCommit[]> {
    const api = await this.api();
    const view = await this.#branchView(api, ref);
    const real = (await api.commits(view.readAt, limitOf(limit))).map(commitSummary);
    const simulated: GildCommit[] = view.commits.toReversed().map(c => ({
      id: c.payload.ref, message: c.payload.message, author: api.agent,
      date: new Date(c.payload.seconds * 1000).toISOString(), parents: [c.payload.base],
      url: api.webUrl(`/tree/${encodeURIComponent(c.payload.branch)}`), pending: true,
    }));
    return [...simulated, ...real].slice(0, limitOf(limit));
  }

  #pendingFile(commits: Extract<GildAction, { kind: "commitFiles" }>[], path: string): FileChange | undefined {
    let found: FileChange | undefined;
    for (const c of commits) for (const f of c.payload.files) if (f.path === path) found = f;
    return found;
  }

  async readFile(path: string, ref: string | undefined): Promise<GildFile> {
    validatePath(path);
    const api = await this.api();
    const view = await this.#branchView(api, ref);
    const pending = this.#pendingFile(view.commits, path);
    if (pending) {
      if (pending.content === null) throw new Error(`${path} is deleted on ${view.branch} by a pending commit.`);
      return { path, ref: view.branch, size: new TextEncoder().encode(pending.content).length, content: pending.content, pending: true };
    }
    const found = await api.contents(path, view.readAt);
    if (found === null || Array.isArray(found)) throw new Error(`${path} is not a file on ${view.branch}.`);
    if (found.type !== "file" || found.content === undefined) throw new Error(`${path} is a ${found.type}, not a text file.`);
    let content: string;
    try {
      content = decodeBase64Text(found.content);
    } catch {
      throw new Error(`${path} is not UTF-8 text.`);
    }
    return { path, ref: view.branch, size: found.size, content };
  }

  async listFiles(path: string, ref: string | undefined): Promise<GildFileEntry[]> {
    if (path) validatePath(path);
    const api = await this.api();
    const view = await this.#branchView(api, ref);
    const listing = await api.contents(path, view.readAt);
    if (listing !== null && !Array.isArray(listing)) throw new Error(`${path} is a file, not a directory.`);
    const entries = new Map<string, GildFileEntry>((listing ?? []).map((e: ApiContent) =>
      [e.name, { name: e.name, path: e.path, type: e.type, size: e.size }]));
    const prefix = path ? `${path}/` : "";
    for (const c of view.commits) for (const f of c.payload.files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      const name = rest.split("/")[0]!;
      const isDir = rest.includes("/");
      if (f.content === null && !isDir) entries.delete(name);
      else if (f.content !== null) {
        entries.set(name, isDir
          ? { name, path: prefix + name, type: "dir", size: 0 }
          : { name, path: f.path, type: "file", size: new TextEncoder().encode(f.content).length });
      }
    }
    if (listing === null && entries.size === 0) throw new Error(`${path || "/"} does not exist on ${view.branch}.`);
    return [...entries.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async codeScore(ref: string | undefined): Promise<GildCodeScore | null> {
    const api = await this.api();
    const target = ref ?? await this.#defaultBranchName(api);
    return scoreOf(target, await api.health(target));
  }

  #overlayIssue<T extends GildIssueSummary & { body?: string; discussion?: GildComment[] }>(item: T, aliases: string[]): T {
    let out = { ...item };
    for (const a of this.#pending()) {
      if (a.kind === "updateIssue" && aliases.includes(a.payload.target)) {
        out = {
          ...out,
          ...(a.payload.title !== undefined ? { title: a.payload.title } : {}),
          ...(a.payload.body !== undefined && out.body !== undefined ? { body: a.payload.body } : {}),
          ...(a.payload.state !== undefined ? { state: a.payload.state } : {}),
          pending: true,
        };
      } else if (a.kind === "comment" && aliases.includes(a.payload.target)) {
        out = { ...out, comments: out.comments + 1, pending: true };
        if (out.discussion) out.discussion = [...out.discussion, { author: "(you, pending)", body: a.payload.body, createdAt: "pending", pending: true }];
      }
    }
    return out;
  }

  /** The provisional ids that now stand for a real number, so writes queued against either apply. */
  #aliases(id: string): string[] {
    const aliases = [id];
    for (const a of this.#pending()) {
      if ((a.kind === "createIssue" || a.kind === "createPullRequest") && this.#items.isResolved(a.payload.ref)
        && this.#items.resolve(a.payload.ref) === id) aliases.push(a.payload.ref);
    }
    return aliases;
  }

  async listIssues(state: "open" | "closed" | "all" = "open", limit?: number): Promise<GildIssueSummary[]> {
    const api = await this.api();
    const real = (await api.issues(state, limitOf(limit))).filter(i => !i.pull_request)
      .map(i => this.#overlayIssue(issueSummary(api, i), this.#aliases(String(i.number))))
      .filter(i => state === "all" || i.state === state);
    const created = this.#pending().flatMap(a => a.kind === "createIssue" && !this.#items.isResolved(a.payload.ref)
      ? [this.#overlayIssue(this.#simulatedIssue(api, a.payload), [a.payload.ref])] : [])
      .filter(i => state === "all" || i.state === state);
    return [...created.toReversed(), ...real];
  }

  #simulatedIssue(api: GildApi, p: GildActions["createIssue"]): GildIssue {
    const now = new Date().toISOString();
    return {
      id: p.ref, title: p.title, state: "open", author: api.agent, labels: p.labels, comments: 0,
      createdAt: now, updatedAt: now, url: api.webUrl(`/issues`), pending: true, body: p.body, discussion: [],
    };
  }

  #realId(id: string): number | null {
    if (/^[1-9][0-9]{0,14}$/.test(id)) return Number(id);
    if (isProvisional(id) && !isCommitRef(id) && this.#items.isResolved(id)) return Number(this.#items.resolve(id));
    return null;
  }

  async issue(id: string): Promise<GildIssue> {
    const api = await this.api();
    const number = this.#realId(id);
    if (number === null) {
      const created = this.#pending().find(a => a.kind === "createIssue" && a.payload.ref === id);
      if (!created || created.kind !== "createIssue") throw new Error(`No issue ${id} in ${api.repo}.`);
      return this.#overlayIssue(this.#simulatedIssue(api, created.payload), [id]);
    }
    const [issue, comments] = await Promise.all([api.issue(number), api.issueComments(number)]);
    return this.#overlayIssue({ ...issueSummary(api, issue), body: issue.body, discussion: comments.map(commentOf) },
      this.#aliases(String(number)));
  }

  async listPulls(state: "open" | "closed" | "all" = "open", limit?: number): Promise<GildPullRequestSummary[]> {
    const api = await this.api();
    const real = (await api.pulls(state, limitOf(limit))).map(p => this.#overlayIssue(pullSummary(api, p), this.#aliases(String(p.number))));
    const created = this.#pending().flatMap(a => a.kind === "createPullRequest" && !this.#items.isResolved(a.payload.ref)
      ? [this.#simulatedPull(api, a.payload)] : []);
    return [...(state === "closed" ? [] : created.toReversed()), ...real];
  }

  #simulatedPull(api: GildApi, p: GildActions["createPullRequest"]): GildPullRequest {
    const now = new Date().toISOString();
    const commits = this.#pending().filter((a): a is Extract<GildAction, { kind: "commitFiles" }> =>
      a.kind === "commitFiles" && a.payload.branch === p.head);
    const files = new Map<string, { path: string; status: string; additions: number; deletions: number }>();
    for (const c of commits) for (const f of c.payload.files) {
      files.set(f.path, { path: f.path, status: f.content === null ? "removed" : "pending", additions: f.content?.split("\n").length ?? 0, deletions: 0 });
    }
    return {
      id: p.ref, title: p.title, state: "open", author: api.agent, labels: [], comments: 0, createdAt: now,
      updatedAt: now, url: api.webUrl("/pulls"), pending: true, head: p.head, base: p.base,
      headCommit: this.pendingHead(p.head) ?? p.after ?? "", merged: false, draft: false, body: p.body,
      files: [...files.values()], reviews: [], discussion: [], codeScore: null,
    };
  }

  async pull(id: string): Promise<GildPullRequest> {
    const api = await this.api();
    const number = this.#realId(id);
    if (number === null) {
      const created = this.#pending().find(a => a.kind === "createPullRequest" && a.payload.ref === id);
      if (!created || created.kind !== "createPullRequest") throw new Error(`No pull request ${id} in ${api.repo}.`);
      return this.#overlayIssue(this.#simulatedPull(api, created.payload), [id]);
    }
    const pull = await api.pull(number);
    const [files, reviews, comments, health] = await Promise.all([
      api.pullFiles(number), api.pullReviews(number), api.issueComments(number), api.health(pull.head.sha),
    ]);
    return this.#overlayIssue({
      ...pullSummary(api, pull), body: pull.body,
      files: files.map(f => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
      reviews: reviews.map(r => ({ author: r.user.login, state: r.state, body: r.body, submittedAt: r.submitted_at })),
      discussion: comments.map(commentOf), codeScore: scoreOf(pull.head.sha, health),
    }, this.#aliases(String(number)));
  }

  async channel(before: string | undefined, limit: number | undefined): Promise<GildChannelMessage[]> {
    const api = await this.api();
    const page = await api.channel({ before, limit: Math.min(limitOf(limit, 50), 200) });
    const pending = before === undefined ? this.#pending().flatMap(a => a.kind === "postToChannel"
      ? [{ cursor: "pending", author: api.agent, authorKind: "agent" as const, kind: "message" as const, body: a.payload.body, createdAt: "pending", link: null, pending: true as const }]
      : []) : [];
    return [...page.messages.map(channelOf), ...pending];
  }

  /** Whether an issue/PR id names something this binding can write to (real or pending). */
  async requireItem(id: string): Promise<void> {
    if (this.#realId(id) !== null) {
      await (await this.api()).issue(this.#realId(id)!);
      return;
    }
    if (!this.#pending().some(a => (a.kind === "createIssue" || a.kind === "createPullRequest") && a.payload.ref === id)) {
      throw new Error(`No issue or pull request ${id} in ${this.#repo()}.`);
    }
  }

  async defaultBranch(): Promise<string> {
    return this.#defaultBranchName(await this.api());
  }

  /** Whether `branch` exists on gild or will once a pending commit lands. */
  async branchExists(branch: string): Promise<boolean> {
    return this.pendingHead(branch) !== null || (await (await this.api()).branchHead(branch)) !== null;
  }
}
