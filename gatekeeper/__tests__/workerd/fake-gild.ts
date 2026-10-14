// A gild faked at the `fetch` boundary. Installed with `vi.stubGlobal`, which reaches the
// gatekeeper because the test file, TestHooks and the facet share one isolate. It is a small
// stateful forge for one repository, `sami/demo`: issues, comments, pulls, branches, a file
// tree, a channel, receive-pack and the agent join endpoints. Anything else -- another origin,
// another repository, a missing token -- is a hard failure, so a test cannot pass on a request
// the gatekeeper should never have made.

import { vi } from "vitest";

export const ORIGIN = "https://gild.test";
export const REPO = "sami/demo";
export const TOKEN = "gf_test_agent_token";
const R = `/api/v1/repos/${REPO}`;

export type Recorded = { method: string; path: string; body?: string; bytes?: Uint8Array; auth: string | null };

const enc = new TextEncoder();
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
const user = (login: string) => ({ login, id: 1, type: "User", html_url: `${ORIGIN}/${login}` });

export class FakeGild {
  readonly requests: Recorded[] = [];
  issues: Array<{ number: number; title: string; body: string; state: "open" | "closed"; labels: string[]; pull?: { head: string; base: string } }> = [
    { number: 1, title: "Existing bug", body: "It breaks.", state: "open", labels: ["bug"] },
  ];
  comments = new Map<number, string[]>();
  channel: string[] = ["hello from sami"];
  branches = new Map<string, string>([["main", "a".repeat(40)]]);
  files = new Map<string, string>([["README.md", "# Demo\n\nThis is teh demo.\n"]]);
  pushes: Array<{ old: string; new: string; ref: string; objects: number }> = [];
  /** Join requests by id: the filed public key and whether the sponsor approved. */
  joins = new Map<string, { publicKey: string; repo: string; agent: string; status: "pending" | "approved" | "denied"; collected: boolean }>();

  install(): void {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => this.#handle(input, init));
  }

  /** Writes the fake received (anything but GET), as `METHOD path`. */
  writes(): string[] {
    return this.requests.filter(r => r.method !== "GET").map(r => `${r.method} ${r.path}`);
  }

  async #handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) throw new Error(`fake gild: request to ${url.origin}, not GILD_URL`);
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const rec: Recorded = {
      method: request.method, path: url.pathname + url.search, bytes,
      body: bytes ? new TextDecoder().decode(bytes) : undefined, auth: request.headers.get("authorization"),
    };
    this.requests.push(rec);
    const p = url.pathname;

    // Agent join: unauthenticated, key-proved.
    if (p === "/api/agents/requests" && request.method === "POST") return this.#join(JSON.parse(rec.body!));
    const collect = p.match(/^\/api\/agents\/requests\/([^/]+)\/token$/);
    if (collect && request.method === "POST") return await this.#collect(collect[1]!, JSON.parse(rec.body!).signature);

    // Everything else is the one repository, with the agent's token.
    if (rec.auth !== `Bearer ${TOKEN}`) return json({ message: "Requires authentication" }, 401);
    if (p === `/${REPO}.git/git-receive-pack` && request.method === "POST") return this.#receivePack(bytes!);
    if (!p.startsWith(R)) throw new Error(`fake gild: ${request.method} ${p} is outside ${REPO}`);
    const route = p.slice(R.length);
    const body = rec.body ? JSON.parse(rec.body) : undefined;

    if (request.method === "GET") {
      if (route === "") return json({ full_name: REPO, description: "demo repo", default_branch: "main", private: false, html_url: `${ORIGIN}/${REPO}`, stargazers_count: 3 });
      if (route === "/branches") return json([...this.branches].map(([name, sha]) => ({ name, commit: { sha, url: "" }, protected: false })));
      const ref = route.match(/^\/git\/ref\/heads\/(.+)$/);
      if (ref) {
        const sha = this.branches.get(decodeURIComponent(ref[1]!));
        return sha ? json({ ref: `refs/heads/${ref[1]}`, object: { type: "commit", sha } }) : json({ message: "Not Found" }, 404);
      }
      const commit = route.match(/^\/commits\/([0-9a-f]{40})$/);
      if (commit) return json({ sha: commit[1], html_url: "", commit: { message: "base", author: { name: "sami", email: "s@x", date: "2026-10-01T00:00:00Z" }, tree: { sha: "b".repeat(40) } }, parents: [] });
      if (route === `/git/trees/${"b".repeat(40)}`) {
        return json({ sha: "b".repeat(40), tree: [{ path: "README.md", mode: "100644", type: "blob", sha: "c".repeat(40) }], truncated: false });
      }
      if (route === "/commits") return json([]);
      const content = route.match(/^\/contents\/(.+)$/);
      if (content) {
        const text = this.files.get(decodeURIComponent(content[1]!));
        return text === undefined ? json({ message: "Not Found" }, 404)
          : json({ type: "file", name: content[1], path: content[1], sha: "c".repeat(40), size: text.length, encoding: "base64", content: b64(text) });
      }
      if (route === "/contents") return json([...this.files.keys()].map(f => ({ type: "file", name: f, path: f, sha: "c".repeat(40), size: 1 })));
      if (route === "/issues") return json(this.issues.map(i => this.#issue(i)));
      if (route === "/pulls") return json(this.issues.filter(i => i.pull).map(i => this.#pull(i)));
      const issue = route.match(/^\/issues\/(\d+)$/);
      if (issue) {
        const found = this.issues.find(i => i.number === Number(issue[1]));
        return found ? json(this.#issue(found)) : json({ message: "Not Found" }, 404);
      }
      const comments = route.match(/^\/issues\/(\d+)\/comments$/);
      if (comments) return json((this.comments.get(Number(comments[1])) ?? []).map((b, i) => ({ id: i, user: user("sami/cfos"), body: b, created_at: "2026-10-09T00:00:00Z", html_url: "" })));
      if (route.startsWith("/channel/messages")) {
        return json({ messages: this.channel.map((b, i) => ({ cursor: String(i + 1), id: String(i), created_at: "2026-10-09T00:00:00Z", reply_to: null, author: { name: "sami", kind: "human" }, kind: "message", body: b, link: null })), cursor: String(this.channel.length), before: null, after: null });
      }
      if (route.startsWith("/health")) return json({ lines: 120, scores: { quality: 91, containment: 90, legibility: 88, security: 95, modularity: 92 }, rules: [] });
    }
    if (request.method === "POST" && route === "/issues") {
      const number = this.issues.length + 1;
      this.issues.push({ number, title: body.title, body: body.body, state: "open", labels: body.labels });
      return json(this.#issue(this.issues.at(-1)!), 201);
    }
    const postComment = route.match(/^\/issues\/(\d+)\/comments$/);
    if (request.method === "POST" && postComment) {
      const n = Number(postComment[1]);
      if (!this.issues.some(i => i.number === n)) return json({ message: "Not Found" }, 404);
      this.comments.set(n, [...(this.comments.get(n) ?? []), body.body]);
      return json({ id: 1, user: user("sami/cfos"), body: body.body, created_at: "", html_url: "" }, 201);
    }
    if (request.method === "POST" && route === "/pulls") {
      if (!this.branches.has(body.head)) return json({ message: `no branch ${body.head}` }, 422);
      const number = this.issues.length + 1;
      this.issues.push({ number, title: body.title, body: body.body, state: "open", labels: [], pull: { head: body.head, base: body.base } });
      return json(this.#pull(this.issues.at(-1)!), 201);
    }
    if (request.method === "POST" && route === "/channel/messages") {
      this.channel.push(body.body);
      return json({ cursor: String(this.channel.length), id: "x", created_at: "", reply_to: null, author: { name: "sami/cfos", kind: "agent" }, kind: "message", body: body.body, link: null }, 201);
    }
    const patch = route.match(/^\/issues\/(\d+)$/);
    if (request.method === "PATCH" && patch) {
      const found = this.issues.find(i => i.number === Number(patch[1]));
      if (!found) return json({ message: "Not Found" }, 404);
      Object.assign(found, body);
      return json(this.#issue(found));
    }
    throw new Error(`fake gild: unrouted ${request.method} ${p}`);
  }

  #issue(i: FakeGild["issues"][number]) {
    return {
      id: i.number, number: i.number, title: i.title, body: i.body, user: user("sami"), state: i.state,
      labels: i.labels.map((name, id) => ({ id, name, color: "", description: null })), comments: (this.comments.get(i.number) ?? []).length,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", closed_at: null,
      html_url: `${ORIGIN}/${REPO}/issues/${i.number}`, url: "", ...(i.pull ? { pull_request: { url: "", html_url: "" } } : {}),
    };
  }

  #pull(i: FakeGild["issues"][number]) {
    return {
      ...this.#issue(i), html_url: `${ORIGIN}/${REPO}/pulls/${i.number}`,
      head: { ref: i.pull!.head, sha: this.branches.get(i.pull!.head) ?? "0".repeat(40) },
      base: { ref: i.pull!.base, sha: this.branches.get(i.pull!.base) ?? "0".repeat(40) },
      merged: false, draft: false, mergeable: true,
    };
  }

  #join(input: { sponsor: string; label: string; publicKey: string; repo: string }): Response {
    const id = `req${this.joins.size + 1}`;
    this.joins.set(id, { publicKey: input.publicKey, repo: input.repo, agent: `${input.sponsor}/${input.label}`, status: "pending", collected: false });
    return json({ id, status: "pending", agent: `${input.sponsor}/${input.label}`, approveUrl: `${ORIGIN}/agents/approve/${id}`, collect: "" }, 201);
  }

  async #collect(id: string, signature: string): Promise<Response> {
    const join = this.joins.get(id);
    if (!join) return json({ error: "no such request" }, 404);
    const der = Uint8Array.from(atob(join.publicKey.replace(/^ed25519:/, "")), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", der.subarray(-32), { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(atob(signature), c => c.charCodeAt(0)), enc.encode(`gild-agent-join:${id}`));
    if (!ok) return json({ error: "signature does not match the key in this request" }, 403);
    if (join.status !== "approved") return json({ status: join.status });
    if (join.collected) return json({ error: "the token for this request was already collected" }, 409);
    join.collected = true;
    return json({ status: "approved", name: join.agent, token: TOKEN, repo: join.repo, grants: ["pr"] });
  }

  /** Parses the pkt-line command and the pack header, then moves the branch. */
  #receivePack(bytes: Uint8Array): Response {
    const len = parseInt(new TextDecoder().decode(bytes.subarray(0, 4)), 16);
    const line = new TextDecoder().decode(bytes.subarray(4, len)).split("\0")[0]!.trim();
    const [old, next, ref] = line.split(" ") as [string, string, string];
    const packAt = bytes.findIndex((b, i) => b === 0x50 && new TextDecoder().decode(bytes.subarray(i, i + 4)) === "PACK");
    const objects = new DataView(bytes.buffer, bytes.byteOffset + packAt).getUint32(8);
    const branch = ref.replace("refs/heads/", "");
    const current = this.branches.get(branch) ?? "0".repeat(40);
    const status = current === old ? "ok" : "ng";
    if (status === "ok") {
      this.branches.set(branch, next);
      this.pushes.push({ old, new: next, ref, objects });
    }
    const report = pkt("unpack ok\n") + pkt(status === "ok" ? `ok ${ref}\n` : `ng ${ref} fetch first\n`) + "0000";
    return new Response(report, { headers: { "content-type": "application/x-git-receive-pack-result" } });
  }
}
