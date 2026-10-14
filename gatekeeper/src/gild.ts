// gild Gatekeeper for Cloudflare OS: entrypoints.
//
//   GatekeeperVendor   the root the Workshop binds (describe, connectAccount, resource types)
//   UserAccount        Durable Object holding one connection: the gild agent token, its repo
//   GildUser           GatekeeperUser for that account (what the Workshop holds)
//   GildVerifier       observer admission: can this collaborator's gild identity read the repo?
//   GildGatekeeperImpl the per-binding facet (gild-gatekeeper.ts)
//
// Connecting runs gild's own agent join flow (join.ts): the account becomes a gild agent
// identity `@<sponsor>/<label>` whose access to exactly one repository the sponsor approves on
// gild.gg. An existing agent token (from `gild agent join` + `gild agent token`) can be pasted
// instead. There is no OAuth client and no deployment secret.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  AvatarImage,
  ConnectHandoff,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, escapeHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { clearCredentialExpiryLatch } from "@gadgets/gatekeeper-kit/credential-expiry";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { GildApi, GildApiError, gildOrigin, logger, REPO_RE } from "./gild-api";
import type { AccountCredentials, GildGatekeeperProps } from "./gild-gatekeeper";
import { collectJoin, fileJoin, GRANTS, type Grant, type PendingJoin } from "./join";
import TYPES_CODE from "./types.txt";

export { GildGatekeeperImpl } from "./gild-gatekeeper";
export { GildRepoSession } from "./gild-session";

type Env = Cloudflare.Env & { BASE_URL?: string; GILD_URL?: string };

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 60 * 60 * 1000; // gild's own join requests expire after an hour.
const MAX_FORM_BYTES = 16 * 1024;

const GILD_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14110c"/><circle cx="32" cy="32" r="17" fill="none" stroke="#e6b450" stroke-width="7"/><path d="M32 32h17" stroke="#e6b450" stroke-width="7"/></svg>`;
const GILD_ICON: AvatarImage = { url: `data:image/svg+xml;utf8,${encodeURIComponent(GILD_LOGO_SVG)}` };

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function newNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function sameNonce(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  return ea.byteLength === eb.byteLength && crypto.subtle.timingSafeEqual(ea, eb);
}

function baseUrl(env: Env): string {
  return (env.BASE_URL ?? "http://localhost:8787/gatekeeper/gild").replace(/\/+$/, "");
}

function origin(env: Env): string {
  return gildOrigin(env.GILD_URL);
}

/** The one resource type: a whole gild repository, e.g. https://gild.gg/owner/name. */
function repoResource(env: Env): SupportedResource {
  return {
    urlPattern: `${origin(env)}/:owner/:repo`,
    title: "gild repository",
    description: "One gild repository: its files, commits, issues, pull requests (with diffs, reviews and code score) and channel.",
    icon: GILD_ICON,
  };
}

/** Parses an attached URL to `owner/name`, accepting deeper links into the repository. */
export function repoOfUrl(env: Env, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  if (parsed.origin !== origin(env)) throw new Error(`"${url}" is not on ${origin(env)}.`);
  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  const name = `${owner ?? ""}/${(repo ?? "").replace(/\.git$/, "")}`;
  if (!REPO_RE.test(name)) throw new Error(`"${url}" does not name a gild repository.`);
  return name.toLowerCase();
}

// --- connect pages -----------------------------------------------------------------------------

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f3ec; --card:#fff; --ink:#1d1a14; --muted:#6b6457; --line:#ddd5c4; --gold:#b8871c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14110c; --card:#0d0a07; --ink:#efe8d8; --muted:#a59c89; --line:#2c261c; --gold:#e6b450; } }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--ink); margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; max-width: 520px; width: 100%; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 20px 0 6px; }
  p, .hint { color: var(--muted); } .hint { font-size: 13px; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .grants label { display: flex; gap: 8px; font-weight: 400; margin: 4px 0; }
  button { margin-top: 16px; padding: 9px 16px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--gold); color: #14110c; cursor: pointer; }
  .error { border: 1px solid #c2410c; color: #c2410c; padding: 8px 12px; border-radius: 8px; margin: 12px 0; }
  a { color: var(--gold); word-break: break-all; } hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
`;

function page(title: string, body: string, status = 200): Response {
  return htmlResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="card">${body}</div></body></html>`, status);
}

function grantBox(g: Grant, text: string, checked: boolean): string {
  return `<label><input type="checkbox" name="grants" value="${g}"${checked ? " checked" : ""}> ${escapeHtml(text)}</label>`;
}

function connectForm(action: string, gild: string, error?: string, values: Record<string, string> = {}): Response {
  const v = (k: string) => escapeHtml(values[k] ?? "");
  return page("Connect gild", `
    <h1>Connect gild</h1>
    <p>Cloudflare OS joins ${escapeHtml(new URL(gild).host)} as an agent that works for you in one repository. You approve it there, like adding a machine to a tailnet.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(action)}/join">
      <label for="sponsor">Your gild name</label>
      <input id="sponsor" name="sponsor" type="text" required placeholder="sami" value="${v("sponsor")}" autocomplete="username">
      <label for="repo">Repository</label>
      <input id="repo" name="repo" type="text" required placeholder="owner/name" value="${v("repo")}">
      <label for="label">Agent name</label>
      <input id="label" name="label" type="text" required value="${v("label") || "cfos"}">
      <div class="hint">The agent becomes @your-name/agent-name on gild.</div>
      <h2>What it may do there</h2>
      <div class="grants">
        ${grantBox("pr", "Open issues and pull requests, comment, push branches", true)}
        ${grantBox("review", "Review pull requests", false)}
        ${grantBox("queue", "Use the merge queue", false)}
      </div>
      <div class="hint">Reading the repository is always included. Every write still waits for your approval in Cloudflare OS.</div>
      <button type="submit">Ask for approval on gild</button>
    </form>
    <hr>
    <form method="POST" action="${escapeHtml(action)}/token">
      <h2>Already joined with the gild CLI?</h2>
      <label for="trepo">Repository</label>
      <input id="trepo" name="repo" type="text" required placeholder="owner/name">
      <label for="tagent">Agent</label>
      <input id="tagent" name="agent" type="text" required placeholder="sami/cfos">
      <label for="token">Agent token (gild agent token &lt;name&gt;)</label>
      <input id="token" name="token" type="password" required autocomplete="off">
      <button type="submit">Connect with this token</button>
    </form>`, error ? 400 : 200);
}

function waitingPage(action: string, join: Pick<PendingJoin, "agent" | "repo" | "approveUrl" | "grants">, note?: string): Response {
  return page("Waiting for approval", `
    <h1>Waiting for approval</h1>
    <p>Ask the sponsor to approve <b>@${escapeHtml(join.agent)}</b> for <b>${escapeHtml(join.repo)}</b> (${escapeHtml(join.grants.join(", ") || "read")}):</p>
    <p><a href="${escapeHtml(join.approveUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(join.approveUrl)}</a></p>
    ${note ? `<div class="error">${escapeHtml(note)}</div>` : ""}
    <form method="POST" action="${escapeHtml(action)}/collect" id="collect"><button type="submit">I approved it — continue</button></form>
    <p class="hint">This page checks every 5 seconds. The request expires after an hour.</p>
    <script>setTimeout(() => document.getElementById("collect").submit(), 5000)</script>`);
}

const EXPIRED = () => page("Link expired", `<h1>This link has expired</h1><p>Return to Cloudflare OS and connect gild again.</p>`, 410);

// --- fetch handler: the connect flow ----------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = new URL(baseUrl(env)).pathname.replace(/\/$/, "");
    if (!url.pathname.startsWith(`${basePath}/`)) return new Response("Not Found", { status: 404 });
    const [doId, nonce, step] = url.pathname.slice(basePath.length + 1).split("/");
    if (!doId || doId.length !== 64 || !nonce || nonce.length !== NONCE_BYTES * 2) return new Response("Not Found", { status: 404 });
    const exports = ctx.exports as unknown as { UserAccount: DurableObjectNamespace<UserAccount> };
    let account: DurableObjectStub<UserAccount>;
    try {
      account = exports.UserAccount.get(exports.UserAccount.idFromString(doId));
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    const action = `${baseUrl(env)}/${doId}/${nonce}`;
    const gild = origin(env);

    if (req.method === "GET" && step === undefined) {
      if (!await account.nonceValid(nonce)) return EXPIRED();
      const join = await account.pendingJoin(nonce);
      return join ? waitingPage(action, join) : connectForm(action, gild);
    }
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readTextCapped(req, MAX_FORM_BYTES));
    } catch {
      return new Response("Invalid form submission.", { status: 400 });
    }
    const values = Object.fromEntries([...form.entries()].filter(([k]) => k !== "token"));

    if (step === "join") {
      const result = await account.startJoin(nonce, {
        sponsor: form.get("sponsor") ?? "", repo: form.get("repo") ?? "", label: form.get("label") ?? "",
        grants: form.getAll("grants"),
      });
      if (result.kind === "invalid_nonce") return EXPIRED();
      if (result.kind === "error") return connectForm(action, gild, result.message, values);
      return waitingPage(action, result.join);
    }
    if (step === "collect") {
      const result = await account.finishJoin(nonce);
      if (result.kind === "invalid_nonce") return EXPIRED();
      if (result.kind === "waiting") return waitingPage(action, result.join, result.note);
      if (result.kind === "error") return connectForm(action, gild, result.message);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }
    if (step === "token") {
      const result = await account.connectWithToken(nonce, {
        repo: form.get("repo") ?? "", agent: form.get("agent") ?? "", token: form.get("token") ?? "",
      });
      if (result.kind === "invalid_nonce") return EXPIRED();
      if (result.kind === "error") return connectForm(action, gild, result.message, values);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }
    return new Response("Not Found", { status: 404 });
  },
};

// --- vendor ------------------------------------------------------------------------------------

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "gild",
      url: origin(this.env),
      logo: GILD_ICON,
      color: "#14110c",
      tagline: "Work on a gild repository: issues, pull requests, code and its channel.",
      description:
        "Attach one gild repository so agents and gadgets can read its code, issues, pull requests " +
        "(with diffs, reviews and cqx code scores) and channel, and propose changes. Cloudflare OS " +
        "joins gild as an agent you approve on gild.gg; every write waits for your approval here.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const exports = this.ctx.exports as unknown as { UserAccount: DurableObjectNamespace<UserAccount> };
    const id = exports.UserAccount.newUniqueId();
    const nonce = newNonce();
    await exports.UserAccount.get(id).setCallback(callback, nonce);
    return { url: `${baseUrl(this.env)}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [repoResource(this.env)];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// --- account -----------------------------------------------------------------------------------

type StoredCredentials = { token: string; agent: string; repo: string; grants: string[]; generation: string };
type StoredNonce = { value: string; expiresAt: number; reconnect?: true; busy?: true };
type Outcome<T> = { kind: "invalid_nonce" } | { kind: "error"; message: string } | T;

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export class UserAccount extends DurableObject<Env> {
  #kv() {
    return this.ctx.storage.kv;
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.#kv().get<StoredCredentials>("credentials")) await this.ctx.storage.setAlarm(Date.now() + NONCE_LIFETIME_MS);
    this.#kv().put("callback", callback);
    this.#kv().put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
    this.#kv().delete("join");
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.#kv().put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS, reconnect: true });
    this.#kv().delete("join");
  }

  #nonce(nonce: string): StoredNonce | null {
    const stored = this.#kv().get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !sameNonce(stored.value, nonce)) return null;
    return stored;
  }

  nonceValid(nonce: string): boolean {
    return this.#nonce(nonce) !== null;
  }

  pendingJoin(nonce: string): PendingJoin | null {
    if (!this.#nonce(nonce)) return null;
    return this.#kv().get<PendingJoin>("join") ?? null;
  }

  async startJoin(nonce: string, input: { sponsor: string; repo: string; label: string; grants: string[] }):
      Promise<Outcome<{ kind: "filed"; join: PendingJoin }>> {
    const stored = this.#nonce(nonce);
    if (!stored || stored.busy) return { kind: "invalid_nonce" };
    const sponsor = input.sponsor.trim().replace(/^@/, "").toLowerCase();
    const repo = input.repo.trim().replace(/^@/, "").toLowerCase();
    const label = input.label.trim().toLowerCase();
    if (!NAME_RE.test(sponsor)) return { kind: "error", message: "Your gild name is 1 to 39 letters, digits or dashes." };
    if (!REPO_RE.test(repo)) return { kind: "error", message: "Name the repository as owner/name." };
    if (!LABEL_RE.test(label)) return { kind: "error", message: "The agent name is 1 to 31 lowercase letters, digits or dashes." };
    const grants = GRANTS.filter(g => input.grants.includes(g));
    this.#kv().put<StoredNonce>("nonce", { ...stored, busy: true });
    try {
      const join = await fileJoin(origin(this.env), {
        sponsor, label, repo, grants, note: `Cloudflare OS gatekeeper for ${repo}`,
      });
      this.#kv().put("join", join);
      logger.info("gild join filed", { event: "gild.join.filed", agent: join.agent, repo });
      return { kind: "filed", join };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      const now = this.#kv().get<StoredNonce>("nonce");
      if (now && sameNonce(now.value, nonce)) this.#kv().put<StoredNonce>("nonce", { ...now, busy: undefined });
    }
  }

  async finishJoin(nonce: string): Promise<Outcome<{ kind: "waiting"; join: PendingJoin; note?: string } | { kind: "connected"; handoff: ConnectHandoff }>> {
    const stored = this.#nonce(nonce);
    const join = this.#kv().get<PendingJoin>("join");
    if (!stored || stored.busy || !join) return { kind: "invalid_nonce" };
    this.#kv().put<StoredNonce>("nonce", { ...stored, busy: true });
    let result;
    try {
      result = await collectJoin(origin(this.env), join);
    } catch (error) {
      this.#release(nonce);
      return { kind: "waiting", join, note: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === "pending") {
      this.#release(nonce);
      return { kind: "waiting", join };
    }
    if (result.status !== "approved") {
      this.#kv().delete("join");
      this.#release(nonce);
      return { kind: "error", message: `The request was ${result.status} on gild. Ask again.` };
    }
    if (result.repo?.toLowerCase() !== join.repo) {
      // gild withholds the repository when the approver cannot read it; such a token reaches nothing.
      this.#kv().delete("join");
      this.#release(nonce);
      return { kind: "error", message: `@${result.agent} was approved, but without access to ${join.repo}.` };
    }
    this.#kv().delete("join");
    return await this.#complete(nonce, stored, { token: result.token, agent: result.agent, repo: join.repo, grants: result.grants });
  }

  async connectWithToken(nonce: string, input: { repo: string; agent: string; token: string }):
      Promise<Outcome<{ kind: "connected"; handoff: ConnectHandoff }>> {
    const stored = this.#nonce(nonce);
    if (!stored || stored.busy) return { kind: "invalid_nonce" };
    const repo = input.repo.trim().replace(/^@/, "").toLowerCase();
    const agent = input.agent.trim().replace(/^@/, "").toLowerCase();
    const token = input.token.trim();
    if (!REPO_RE.test(repo)) return { kind: "error", message: "Name the repository as owner/name." };
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(agent)) return { kind: "error", message: "Name the agent as sponsor/label." };
    if (!token) return { kind: "error", message: "Paste the agent's token." };
    this.#kv().put<StoredNonce>("nonce", { ...stored, busy: true });
    try {
      await new GildApi({ origin: origin(this.env), token, agent, repo }).repository();
    } catch (error) {
      this.#release(nonce);
      const status = error instanceof GildApiError ? error.status : 0;
      return { kind: "error", message: status === 401 ? "gild did not accept that token." : status === 404 ? `That token cannot read ${repo}.` : `Could not reach gild: ${error instanceof Error ? error.message : String(error)}` };
    }
    return await this.#complete(nonce, stored, { token, agent, repo, grants: [] });
  }

  #release(nonce: string): void {
    const now = this.#kv().get<StoredNonce>("nonce");
    if (now && sameNonce(now.value, nonce)) this.#kv().put<StoredNonce>("nonce", { ...now, busy: undefined });
  }

  async #complete(nonce: string, stored: StoredNonce, creds: Omit<StoredCredentials, "generation">):
      Promise<Outcome<{ kind: "connected"; handoff: ConnectHandoff }>> {
    const callback = this.#kv().get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return { kind: "error", message: "The connection request expired. Start again from Cloudflare OS." };
    this.#kv().delete("nonce");
    const record: StoredCredentials = { ...creds, generation: crypto.randomUUID() };
    try {
      let handoff: ConnectHandoff;
      if (stored.reconnect) {
        // A reconnect link is a bearer capability: stage until the Workshop confirms the owner.
        handoff = await callback.reconnectComplete(stageCredentials(this.#kv(), record, Date.now()));
      } else {
        this.#kv().put("credentials", record);
        clearCredentialExpiryLatch(this.#kv());
        const exports = this.ctx.exports as unknown as { GildUser(o: { props: { userObjectId: string } }): Fetcher<GatekeeperUser> };
        handoff = await callback.complete(exports.GildUser({ props: { userObjectId: this.ctx.id.toString() } }));
        await this.ctx.storage.deleteAlarm();
      }
      logger.info("gild connected", { event: "gild.connected", agent: record.agent, repo: record.repo });
      return { kind: "connected", handoff };
    } catch (error) {
      if (!stored.reconnect) this.#kv().delete("credentials");
      return { kind: "error", message: `Could not finish connecting: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<StoredCredentials>(this.#kv(), Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#kv().put("credentials", staged);
    clearCredentialExpiryLatch(this.#kv());
  }

  /** What facets and the user entrypoint read. Never leaves this worker's own RPC. */
  credentials(): AccountCredentials {
    const creds = this.#kv().get<StoredCredentials>("credentials");
    if (!creds) throw new Error("This gild connection is not set up. Connect gild again.");
    return { origin: origin(this.env), token: creds.token, agent: creds.agent, repo: creds.repo, generation: creds.generation };
  }

  summary(): { agent: string; repo: string; grants: string[] } {
    const creds = this.#kv().get<StoredCredentials>("credentials");
    if (!creds) throw new Error("This gild connection is not set up. Connect gild again.");
    return { agent: creds.agent, repo: creds.repo, grants: creds.grants };
  }

  async alarm(): Promise<void> {
    if (!this.#kv().get<StoredCredentials>("credentials")) await this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    // gild agent tokens are revoked by the sponsor on gild.gg (or `gild agent` there); locally the
    // Workshop's authority ends here.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// --- the Workshop-facing account ----------------------------------------------------------------

type UserProps = { userObjectId: string };

@validateRpc()
export class GildUser extends WorkerEntrypoint<Env, UserProps> implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    const exports = this.ctx.exports as unknown as { UserAccount: DurableObjectNamespace<UserAccount> };
    return exports.UserAccount.get(exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const s = await this.#account().summary();
    return { displayName: `@${s.agent} on gild`, uniqueName: `${s.agent} → ${s.repo}`, avatar: GILD_ICON };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [repoResource(this.env)];
  }

  /**
   * Narrowing: a connection is one gild agent scoped (by gild) to one repository, and it can be
   * attached to that repository only. Another repository's URL is refused here, before any
   * gatekeeper exists for it.
   */
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const repo = repoOfUrl(this.env, url);
    const s = await this.#account().summary();
    if (repo !== s.repo.toLowerCase()) {
      throw new Error(`This gild connection (@${s.agent}) is scoped to ${s.repo} and cannot be attached to ${repo}. Connect gild again for that repository.`);
    }
    const props: GildGatekeeperProps = { userObjectId: this.ctx.props.userObjectId, repo };
    const exports = this.ctx.exports as unknown as { GildGatekeeperImpl(o: { props: GildGatekeeperProps }): DurableObjectClass<Gatekeeper<any>> };
    return { class: exports.GildGatekeeperImpl({ props }), resource: repoResource(this.env) };
  }

  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Paste the gild repository URL (https://gild.gg/owner/name) to attach it.");
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = newNonce();
    await this.#account().prepareReconnect(nonce);
    return { url: `${baseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const exports = this.ctx.exports as unknown as { GildVerifier(o: { props: UserProps }): Fetcher<GatekeeperUserVerifier> };
    return exports.GildVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
  }

  async ensureResources(_patterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

/**
 * A collaborator's capability, passed back to `addObserver`. It answers one question with the
 * collaborator's own gild identity: can it read this repository?
 */
@validateRpc()
export class GildVerifier extends WorkerEntrypoint<Env, UserProps> implements GatekeeperUserVerifier {
  async canReadRepo(repo: string): Promise<boolean> {
    const exports = this.ctx.exports as unknown as { UserAccount: DurableObjectNamespace<UserAccount> };
    const account = exports.UserAccount.get(exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    let creds: AccountCredentials;
    try {
      creds = await account.credentials();
    } catch {
      return false;
    }
    if (creds.repo.toLowerCase() !== repo.toLowerCase()) return false;
    try {
      await new GildApi({ ...creds, repo }).repository();
      return true;
    } catch (error) {
      if (error instanceof GildApiError && [401, 403, 404].includes(error.status)) return false;
      throw error;
    }
  }
}
