// The capability an agent or gadget holds for one attached gild repository. Every read is
// fetched, then authorized as an observation (the Workshop's audit log of what was disclosed),
// then returned -- in that order, so the description names what was actually read. Every write
// is submitted to the approval queue and answered with its simulated result.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { escapeObservationValue, ObservationGate } from "@gadgets/gatekeeper-kit/observers";
import type { GildGatekeeperImpl } from "./gild-gatekeeper";
import type {
  GildBranch, GildChannelMessage, GildCodeScore, GildCommit, GildFile, GildFileEntry, GildIssue,
  GildIssueSummary, GildPullRequest, GildPullRequestSummary, GildRepo, GildRepoMetadata,
} from "./types";

const BASELINE = { kind: "baseline" } as const;
const esc = escapeObservationValue;

@validateRpc()
export class GildRepoSession extends RpcTarget implements GildRepo {
  readonly #gatekeeper: GildGatekeeperImpl;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #gate: ObservationGate;

  constructor(gatekeeper: GildGatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#queue = queue;
    this.#gate = new ObservationGate(queue.dup(), gatekeeper.observers);
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    (this.#queue as RpcStub<ApprovalQueue> & Disposable)[Symbol.dispose]();
  }

  async #observe<T>(read: Promise<T>, title: (value: T) => string, description: (value: T) => string): Promise<T> {
    const value = await read;
    await this.#gate.authorize({ title: title(value), description: description(value) }, BASELINE);
    return value;
  }

  // -- reads ------------------------------------------------------------------------------------

  getMetadata(): Promise<GildRepoMetadata> {
    return this.#observe(this.#gatekeeper.metadata(),
      m => `Read gild repository ${esc(m.repo)}`, m => `Read metadata of the gild repository **${esc(m.repo)}**.`);
  }

  listBranches(): Promise<GildBranch[]> {
    return this.#observe(this.#gatekeeper.branches(),
      b => `Listed ${b.length} gild branches`, b => `Listed the repository's branches (${b.length}).`);
  }

  listCommits(options?: { ref?: string; limit?: number }): Promise<GildCommit[]> {
    return this.#observe(this.#gatekeeper.listCommits(options?.ref, options?.limit),
      c => `Read ${c.length} gild commits`,
      c => `Read ${c.length} commits on ${esc(options?.ref ?? "the default branch")}, with messages and authors.`);
  }

  listFiles(path = "", ref?: string): Promise<GildFileEntry[]> {
    return this.#observe(this.#gatekeeper.listFiles(path, ref),
      e => `Listed gild directory ${esc(path || "/")}`,
      e => `Listed ${e.length} entries of ${esc(path || "/")} at ${esc(ref ?? "the default branch")}.`);
  }

  readFile(path: string, ref?: string): Promise<GildFile> {
    return this.#observe(this.#gatekeeper.readFile(path, ref),
      f => `Read gild file ${esc(f.path)}`,
      f => `Read **${esc(f.path)}** (${f.size} bytes) at ${esc(f.ref)}${f.pending ? ", as a pending commit leaves it" : ""}.`);
  }

  getCodeScore(ref?: string): Promise<GildCodeScore | null> {
    return this.#observe(this.#gatekeeper.codeScore(ref),
      () => `Read gild code score`, s => s
        ? `Read the cqx code score at ${esc(s.ref)}: quality ${s.quality}.`
        : `Asked for the code score at ${esc(ref ?? "the default branch")}; it is not ready.`);
  }

  listIssues(options?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<GildIssueSummary[]> {
    return this.#observe(this.#gatekeeper.listIssues(options?.state, options?.limit),
      i => `Listed ${i.length} gild issues`, i => `Listed ${i.length} ${options?.state ?? "open"} issues with titles and labels.`);
  }

  getIssue(id: string): Promise<GildIssue> {
    return this.#observe(this.#gatekeeper.issue(id),
      i => `Read gild issue #${esc(i.id)}`,
      i => `Read issue #${esc(i.id)} "${esc(i.title)}" with its body and ${i.discussion.length} comments.`);
  }

  listPullRequests(options?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<GildPullRequestSummary[]> {
    return this.#observe(this.#gatekeeper.listPulls(options?.state, options?.limit),
      p => `Listed ${p.length} gild pull requests`, p => `Listed ${p.length} ${options?.state ?? "open"} pull requests.`);
  }

  getPullRequest(id: string): Promise<GildPullRequest> {
    return this.#observe(this.#gatekeeper.pull(id),
      p => `Read gild pull request #${esc(p.id)}`,
      p => `Read pull request #${esc(p.id)} "${esc(p.title)}": its diff (${p.files.length} files), ${p.reviews.length} reviews, comments and code score.`);
  }

  readChannel(options?: { before?: string; limit?: number }): Promise<GildChannelMessage[]> {
    return this.#observe(this.#gatekeeper.channel(options?.before, options?.limit),
      m => `Read ${m.length} gild channel messages`, m => `Read ${m.length} messages from the repository channel.`);
  }

  // -- writes: queued for approval, simulated immediately ---------------------------------------

  async createIssue(options: { title: string; body?: string; labels?: string[] }): Promise<GildIssueSummary> {
    const title = options.title.trim();
    if (!title) throw new Error("An issue needs a title.");
    const ref = this.#gatekeeper.allocateItem();
    await this.#gatekeeper.submit(this.#queue, "createIssue", { ref, title, body: options.body ?? "", labels: options.labels ?? [] });
    return await this.#gatekeeper.issue(ref);
  }

  async updateIssue(id: string, changes: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void> {
    if (changes.title === undefined && changes.body === undefined && changes.state === undefined) {
      throw new Error("Nothing to change.");
    }
    await this.#gatekeeper.requireItem(id);
    await this.#gatekeeper.submit(this.#queue, "updateIssue", { target: id, ...changes });
  }

  async comment(id: string, body: string): Promise<void> {
    if (!body.trim()) throw new Error("A comment needs a body.");
    await this.#gatekeeper.requireItem(id);
    await this.#gatekeeper.submit(this.#queue, "comment", { target: id, body });
  }

  async commitFiles(options: {
    branch: string;
    message: string;
    files: Array<{ path: string; content: string } | { path: string; delete: true }>;
    base?: string;
  }): Promise<GildCommit> {
    const files = options.files.map(f => "delete" in f && f.delete
      ? { path: f.path, content: null }
      : { path: f.path, content: (f as { content: string }).content });
    const payload = await this.#gatekeeper.prepareCommit({ branch: options.branch, message: options.message, files, base: options.base });
    await this.#gatekeeper.submit(this.#queue, "commitFiles", payload);
    return {
      id: payload.ref, message: payload.message, author: (await this.#gatekeeper.api()).agent,
      date: new Date(payload.seconds * 1000).toISOString(), parents: [payload.base],
      url: (await this.#gatekeeper.api()).webUrl(`/tree/${encodeURIComponent(payload.branch)}`), pending: true,
    };
  }

  async createPullRequest(options: { title: string; head: string; base?: string; body?: string }): Promise<GildPullRequestSummary> {
    const title = options.title.trim();
    if (!title) throw new Error("A pull request needs a title.");
    const base = options.base ?? await this.#gatekeeper.defaultBranch();
    if (base === options.head) throw new Error("head and base must be different branches.");
    if (!await this.#gatekeeper.branchExists(options.head)) throw new Error(`There is no branch ${options.head}; commitFiles() to it first.`);
    if (!await this.#gatekeeper.branchExists(base)) throw new Error(`There is no branch ${base}.`);
    const ref = this.#gatekeeper.allocateItem();
    const after = this.#gatekeeper.pendingHead(options.head) ?? undefined;
    await this.#gatekeeper.submit(this.#queue, "createPullRequest", {
      ref, title, body: options.body ?? "", head: options.head, base, ...(after ? { after } : {}),
    });
    return await this.#gatekeeper.pull(ref);
  }

  async postToChannel(body: string): Promise<void> {
    const text = body.trim();
    if (!text || text.length > 4000) throw new Error("A channel message is 1 to 4000 characters.");
    await this.#gatekeeper.submit(this.#queue, "postToChannel", { body: text });
  }
}
