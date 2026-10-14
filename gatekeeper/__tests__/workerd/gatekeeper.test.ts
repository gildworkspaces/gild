// The gild Gatekeeper's contract, end to end inside workerd against a fake gild:
//
//   - every write is simulated until approved (reads show it, gild receives nothing), and is real
//     once approved (gild receives exactly the approved request);
//   - a rejected write never reaches gild, and neither does anything that depended on it;
//   - narrowing: the binding reaches exactly the attached repository, and a second repository is
//     refused before any gatekeeper exists for it;
//   - connecting runs gild's agent join flow, proving the key it filed;
//   - every read is authorized as an observation before it is returned.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGild, ORIGIN, REPO, TOKEN } from "./fake-gild.js";
import type { Outcome } from "./worker.js";

afterEach(() => vi.unstubAllGlobals());

let gild: FakeGild;
beforeEach(() => {
  gild = new FakeGild();
  gild.install();
});

const hooks = () => env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));

async function seedAccount(repo = REPO, generation = "gen-1"): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_i, state) => {
    state.storage.kv.put("credentials", { token: TOKEN, agent: "sami/cfos", repo, grants: ["pr"], generation });
  });
  return id.toString();
}

function ok<T>(o: Outcome<T>): T {
  if ("error" in o) throw new Error(o.error);
  return o.ok;
}

let n = 0;
async function binding() {
  const userObjectId = await seedAccount();
  const name = `binding-${++n}`;
  const props = { userObjectId, repo: REPO };
  const call = async (method: string, ...args: unknown[]) => ok(await hooks().call(name, props, method, args)) as any;
  const apply = async (id: number) => hooks().apply(name, props, id);
  const reject = async (id: number) => hooks().reject(name, props, id);
  const log = () => hooks().queueLog(name);
  return { name, props, userObjectId, call, apply, reject, log };
}

describe("writes are simulated until approved, real after", () => {
  it("createIssue + comment on the provisional issue", async () => {
    const b = await binding();
    const issue = await b.call("createIssue", { title: "Dashboard request", body: "Build it", labels: ["feature"] });
    expect(issue).toMatchObject({ id: "~1", title: "Dashboard request", pending: true });
    await b.call("comment", "~1", "First comment");

    // Simulated: reads show both writes; gild has received no write at all.
    const issues = await b.call("listIssues");
    expect(issues.map((i: any) => i.id)).toEqual(["~1", "1"]);
    const read = await b.call("getIssue", "~1");
    expect(read.discussion).toMatchObject([{ body: "First comment", pending: true }]);
    expect(gild.writes()).toEqual([]);

    const { submitted } = await b.log();
    expect(submitted.map(s => s.title)).toEqual(["Open an issue on gild", "Comment on #~1 on gild"]);
    expect(submitted.every(s => s.complete)).toBe(true);

    // Approved: the issue is created, then the comment lands on its real number.
    expect(await b.apply(submitted[0]!.id)).toEqual({ ok: null });
    expect(await b.apply(submitted[1]!.id)).toEqual({ ok: null });
    expect(gild.writes()).toEqual([`POST /api/v1/repos/${REPO}/issues`, `POST /api/v1/repos/${REPO}/issues/2/comments`]);
    expect(gild.issues.at(-1)).toMatchObject({ number: 2, title: "Dashboard request", body: "Build it", labels: ["feature"] });
    expect(gild.comments.get(2)).toEqual(["First comment"]);
    // The provisional id still works and now reads the real issue.
    expect(await b.call("getIssue", "~1")).toMatchObject({ id: "2", discussion: [{ body: "First comment" }] });
  });

  it("commitFiles to a new branch + createPullRequest pushes a real commit, then opens the PR", async () => {
    const b = await binding();
    const before = await b.call("readFile", "README.md");
    expect(before.content).toContain("teh demo");

    const commit = await b.call("commitFiles", {
      branch: "fix-readme-typo", message: "Fix typo in README",
      files: [{ path: "README.md", content: before.content.replace("teh", "the") }],
    });
    expect(commit).toMatchObject({ id: "~c1", pending: true, parents: ["a".repeat(40)] });
    const pr = await b.call("createPullRequest", { title: "Fix typo in README", head: "fix-readme-typo" });
    expect(pr).toMatchObject({ id: "~1", head: "fix-readme-typo", base: "main", pending: true });

    // Simulated: the branch, the file on it and the PR exist for the agent; gild has none of them.
    expect((await b.call("readFile", "README.md", "fix-readme-typo")).content).toContain("the demo");
    expect((await b.call("readFile", "README.md")).content).toContain("teh demo");
    expect((await b.call("listBranches")).map((x: any) => x.name)).toContain("fix-readme-typo");
    expect((await b.call("getPullRequest", "~1")).files).toMatchObject([{ path: "README.md" }]);
    expect(gild.writes()).toEqual([]);
    expect(gild.branches.has("fix-readme-typo")).toBe(false);

    const [push, open] = (await b.log()).submitted;
    expect(push!.title).toBe("Push 1 file change to fix-readme-typo on gild");
    // The PR depends on the push: approving it first is refused, and still sends nothing.
    expect(await b.apply(open!.id)).toMatchObject({ error: expect.stringContaining("not applied yet") });
    expect(gild.writes()).toEqual([]);

    expect(await b.apply(push!.id)).toEqual({ ok: null });
    expect(gild.pushes).toMatchObject([{ old: "0".repeat(40), ref: "refs/heads/fix-readme-typo", objects: 3 }]);
    expect(gild.branches.get("fix-readme-typo")).toMatch(/^[0-9a-f]{40}$/);
    expect(await b.apply(open!.id)).toEqual({ ok: null });
    expect(gild.writes()).toEqual([`POST /${REPO}.git/git-receive-pack`, `POST /api/v1/repos/${REPO}/pulls`]);
    expect(gild.issues.at(-1)).toMatchObject({ title: "Fix typo in README", pull: { head: "fix-readme-typo", base: "main" } });
  });

  it("a push whose branch moved on gild is refused, not forced", async () => {
    const b = await binding();
    await b.call("commitFiles", { branch: "main", message: "edit", files: [{ path: "NEW.md", content: "x\n" }] });
    gild.branches.set("main", "d".repeat(40));
    const [push] = (await b.log()).submitted;
    expect(await b.apply(push!.id)).toMatchObject({ error: expect.stringContaining("moved on gild") });
    expect(gild.pushes).toEqual([]);
  });

  it("postToChannel posts once approved, with an idempotency key", async () => {
    const b = await binding();
    await b.call("postToChannel", "Opened a PR for the README typo.");
    expect((await b.call("readChannel")).at(-1)).toMatchObject({ body: "Opened a PR for the README typo.", pending: true });
    expect(gild.writes()).toEqual([]);
    const [post] = (await b.log()).submitted;
    expect(await b.apply(post!.id)).toEqual({ ok: null });
    expect(gild.channel.at(-1)).toBe("Opened a PR for the README typo.");
  });
});

describe("rejected writes never reach gild", () => {
  it("rejecting an issue discards it and the comment that depended on it", async () => {
    const b = await binding();
    await b.call("createIssue", { title: "Unwanted" });
    await b.call("comment", "~1", "on the unwanted issue");
    await b.call("postToChannel", "unwanted post");
    const [create, comment, post] = (await b.log()).submitted;

    expect(await b.reject(create!.id)).toEqual({ ok: null });
    expect(await b.reject(post!.id)).toEqual({ ok: null });
    // The dependent comment was stranded by the rejection: applying it now fails, sending nothing.
    expect(await b.apply(comment!.id)).toMatchObject({ error: expect.any(String) });
    expect(await b.apply(create!.id)).toMatchObject({ error: expect.any(String) });
    expect(gild.writes()).toEqual([]);
    // And the simulation forgets them.
    expect((await b.call("listIssues")).map((i: any) => i.id)).toEqual(["1"]);
    expect((await b.call("readChannel")).some((m: any) => m.pending)).toBe(false);
  });

  it("an action approved under a replaced connection is refused", async () => {
    const b = await binding();
    await b.call("createIssue", { title: "Before reconnect" });
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(b.userObjectId)), async (_i, state) => {
      state.storage.kv.put("credentials", { token: TOKEN, agent: "sami/cfos", repo: REPO, grants: ["pr"], generation: "gen-2" });
    });
    const [create] = (await b.log()).submitted;
    expect(await b.apply(create!.id)).toMatchObject({ error: expect.stringContaining("replaced") });
    expect(gild.writes()).toEqual([]);
  });
});

describe("narrowing: exactly one repository", () => {
  it("attaches the connection's repository and refuses a second one", async () => {
    const userObjectId = await seedAccount();
    expect(ok(await hooks().attach(userObjectId, `${ORIGIN}/${REPO}`))).toBe(`${ORIGIN}/:owner/:repo`);
    expect(ok(await hooks().attach(userObjectId, `${ORIGIN}/${REPO}/pulls/3`))).toBe(`${ORIGIN}/:owner/:repo`);
    expect(await hooks().attach(userObjectId, `${ORIGIN}/sami/other`)).toMatchObject({ error: expect.stringContaining("scoped to sami/demo") });
    expect(await hooks().attach(userObjectId, `https://github.com/${REPO}`)).toMatchObject({ error: expect.stringContaining("not on") });
  });

  it("a binding whose connection now names another repository refuses to read", async () => {
    const userObjectId = await seedAccount("sami/other");
    const result = await hooks().call("narrow", { userObjectId, repo: REPO }, "listIssues", []);
    expect(result).toMatchObject({ error: expect.stringContaining("scoped to sami/other") });
    expect(gild.requests).toEqual([]);
  });

  it("every request the binding makes stays inside the attached repository", async () => {
    const b = await binding();
    await b.call("getMetadata");
    await b.call("listIssues");
    await b.call("readChannel");
    await b.call("getCodeScore");
    for (const r of gild.requests) {
      expect(r.path.startsWith(`/api/v1/repos/${REPO}`) || r.path.startsWith(`/${REPO}.git/`)).toBe(true);
      expect(r.auth).toBe(`Bearer ${TOKEN}`);
    }
  });
});

describe("observations", () => {
  it("authorizes every read before returning it", async () => {
    const b = await binding();
    await b.call("getMetadata");
    await b.call("readFile", "README.md");
    await b.call("listIssues");
    await b.call("getCodeScore");
    expect((await b.log()).observations).toEqual([
      "Read gild repository sami/demo", "Read gild file README\\.md", "Listed 1 gild issues", "Read gild code score",
    ]);
  });
});

describe("connecting runs gild's agent join flow", () => {
  it("files a request, waits for the sponsor, proves the key and collects the token", async () => {
    const userObjectId = env.USER_ACCOUNT.newUniqueId().toString();
    const nonce = "a".repeat(64);
    await hooks().beginConnect(userObjectId, nonce);
    const base = `${env.BASE_URL}/${userObjectId}/${nonce}`;

    const form = await SELF.fetch(base);
    expect(await form.text()).toContain("Ask for approval on gild");

    const filed = await SELF.fetch(`${base}/join`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ sponsor: "sami", repo: REPO, label: "cfos", grants: "pr" }),
    });
    const waiting = await filed.text();
    expect(waiting).toContain(`${ORIGIN}/agents/approve/req1`);
    expect([...gild.joins.values()]).toMatchObject([{ agent: "sami/cfos", repo: REPO, status: "pending" }]);

    // Not approved yet: still waiting, no token.
    expect(await (await SELF.fetch(`${base}/collect`, { method: "POST" })).text()).toContain("Waiting for approval");

    gild.joins.get("req1")!.status = "approved";
    const done = await (await SELF.fetch(`${base}/collect`, { method: "POST" })).text();
    expect(done).toContain("ticket-complete");
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId)), async (_i, state) => {
      expect(state.storage.kv.get("credentials")).toMatchObject({ token: TOKEN, agent: "sami/cfos", repo: REPO });
    });
    // The connect link is spent.
    expect((await SELF.fetch(base)).status).toBe(410);
  });
});
