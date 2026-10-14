#!/usr/bin/env node
// A local stand-in for gild's /api/v1, for running Cloudflare OS with the gild Gatekeeper before
// a real agent identity is approved. One repository (default sami/testing), held in memory:
// issues, comments, pulls, branches, README, channel, the agent join endpoints (auto-approved)
// and receive-pack (the command line is parsed and the branch moved; objects are not stored).
//
//   node scripts/fake-gild-server.mjs --port 8799 --repo sami/testing
//   GILD_URL=http://localhost:8799 for the gatekeeper worker
//
// Every request is logged to stdout as one JSON line, so a run doubles as an audit of exactly
// what the gatekeeper sent -- writes appear only after approval.

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "8799"));
const REPO = arg("repo", "sami/testing");
const ORIGIN = `http://localhost:${PORT}`;
const TOKEN = "gf_fake_local_token";

const files = new Map([["README.md", "# testing\n\nThis repositry is a sandbox for gild agents.\n"], ["push-test.txt", "push\n"]]);
const branches = new Map([["main", "1".repeat(40)]]);
const issues = [{ number: 1, title: "Channel notes should link to the PR", body: "System notes for PRs need a link.", state: "open", labels: ["bug"], created: "2026-10-08T10:00:00Z" },
  { number: 2, title: "Add a CONTRIBUTING guide", body: "", state: "open", labels: ["docs"], created: "2026-10-08T12:00:00Z" },
  { number: 3, title: "Typo in README", body: "repositry", state: "closed", labels: [], created: "2026-10-07T09:00:00Z" }];
const comments = new Map();
const channel = [{ author: "sami", kind: "human", body: "Welcome to sami/testing." }];
const joins = new Map();

const user = login => ({ login, id: 1, type: "User", html_url: `${ORIGIN}/${login}` });
const sha = s => createHash("sha1").update(s).digest("hex");
const issueJson = i => ({
  id: i.number, number: i.number, title: i.title, body: i.body, user: user(i.author ?? "sami"), state: i.state,
  labels: i.labels.map((name, id) => ({ id, name, color: "e6b450", description: null })),
  comments: (comments.get(i.number) ?? []).length, created_at: i.created, updated_at: i.created, closed_at: null,
  html_url: `${ORIGIN}/${REPO}/${i.pull ? "pulls" : "issues"}/${i.number}`, url: "",
  ...(i.pull ? { pull_request: { url: "", html_url: "" } } : {}),
});
const pullJson = i => ({ ...issueJson(i), head: { ref: i.pull.head, sha: branches.get(i.pull.head) ?? "0".repeat(40) }, base: { ref: i.pull.base, sha: branches.get(i.pull.base) }, merged: false, draft: false, mergeable: true });

const pkt = s => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;

function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof data === "string" || data instanceof Buffer ? data : JSON.stringify(data));
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path: p + url.search, auth: req.headers.authorization ? "bearer" : "none" }));
  const body = raw.length && req.headers["content-type"]?.includes("json") ? JSON.parse(raw.toString()) : undefined;

  if (p === "/api/agents/requests" && req.method === "POST") {
    const id = randomUUID().replaceAll("-", "").slice(0, 20);
    joins.set(id, { agent: `${body.sponsor}/${body.label}`, repo: body.repo, grants: body.grants });
    return send(res, 201, { id, status: "pending", agent: `${body.sponsor}/${body.label}`, approveUrl: `${ORIGIN}/agents/approve/${id}`, collect: "" });
  }
  const collect = p.match(/^\/api\/agents\/requests\/([^/]+)\/token$/);
  if (collect && req.method === "POST") {
    const j = joins.get(collect[1]);
    return j ? send(res, 200, { status: "approved", name: j.agent, token: TOKEN, repo: j.repo, grants: j.grants }) : send(res, 404, { error: "no such request" });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: "Requires authentication" });

  if (p === `/${REPO}.git/git-receive-pack` && req.method === "POST") {
    const len = parseInt(raw.subarray(0, 4).toString(), 16);
    const [old, next, ref] = raw.subarray(4, len).toString().split("\0")[0].trim().split(" ");
    const branch = ref.replace("refs/heads/", "");
    const ok = (branches.get(branch) ?? "0".repeat(40)) === old;
    if (ok) branches.set(branch, next);
    console.log(JSON.stringify({ push: { branch, old, new: next, ok, packBytes: raw.length - len - 4 } }));
    return send(res, 200, pkt("unpack ok\n") + pkt(ok ? `ok ${ref}\n` : `ng ${ref} fetch first\n`) + "0000", "application/x-git-receive-pack-result");
  }
  const R = `/api/v1/repos/${REPO}`;
  if (!p.startsWith(R)) return send(res, 404, { message: "Not Found" });
  const route = p.slice(R.length);
  let m;
  if (req.method === "GET") {
    if (route === "") return send(res, 200, { full_name: REPO, description: "Sandbox for gild agents", default_branch: "main", private: false, html_url: `${ORIGIN}/${REPO}`, stargazers_count: 0 });
    if (route === "/branches") return send(res, 200, [...branches].map(([name, s]) => ({ name, commit: { sha: s, url: "" }, protected: false })));
    if ((m = route.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const s = branches.get(decodeURIComponent(m[1]));
      return s ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { type: "commit", sha: s } }) : send(res, 404, { message: "Not Found" });
    }
    if ((m = route.match(/^\/commits\/([0-9a-f]{40})$/))) return send(res, 200, { sha: m[1], html_url: "", commit: { message: "init", author: { name: "sami", email: "s@gild", date: "2026-10-01T00:00:00Z" }, tree: { sha: "2".repeat(40) } }, parents: [] });
    if (route === "/commits") return send(res, 200, [{ sha: branches.get("main"), html_url: "", commit: { message: "init", author: { name: "sami", email: "s@gild", date: "2026-10-01T00:00:00Z" }, tree: { sha: "2".repeat(40) } }, parents: [] }]);
    if (route === `/git/trees/${"2".repeat(40)}`) return send(res, 200, { sha: "2".repeat(40), tree: [...files].map(([path, text]) => ({ path, mode: "100644", type: "blob", sha: sha(`blob ${Buffer.byteLength(text)}\0${text}`) })), truncated: false });
    if (route === "/contents") return send(res, 200, [...files].map(([path, text]) => ({ type: "file", name: path, path, sha: "3".repeat(40), size: Buffer.byteLength(text) })));
    if ((m = route.match(/^\/contents\/(.+)$/))) {
      const text = files.get(decodeURIComponent(m[1]));
      return text === undefined ? send(res, 404, { message: "Not Found" }) : send(res, 200, { type: "file", name: m[1], path: m[1], sha: "3".repeat(40), size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    if (route === "/issues") {
      const state = url.searchParams.get("state") ?? "open";
      return send(res, 200, issues.filter(i => state === "all" || i.state === state).map(issueJson).toReversed());
    }
    if (route === "/pulls") return send(res, 200, issues.filter(i => i.pull).map(pullJson).toReversed());
    if ((m = route.match(/^\/(issues|pulls)\/(\d+)$/))) {
      const i = issues.find(x => x.number === Number(m[2]));
      return i ? send(res, 200, m[1] === "pulls" ? pullJson(i) : issueJson(i)) : send(res, 404, { message: "Not Found" });
    }
    if ((m = route.match(/^\/issues\/(\d+)\/comments$/))) return send(res, 200, (comments.get(Number(m[1])) ?? []).map((b, id) => ({ id, user: user("sami/cfos-gatekeeper"), body: b, created_at: new Date().toISOString(), html_url: "" })));
    if ((m = route.match(/^\/pulls\/(\d+)\/(files|reviews)$/))) return send(res, 200, m[2] === "files" ? [{ filename: "README.md", status: "modified", additions: 1, deletions: 1, patch: "-repositry\n+repository" }] : []);
    if (route === "/health") return send(res, 200, { lines: 3, scores: { quality: 96, containment: 95, legibility: 97, security: 99, modularity: 94 }, rules: [] });
    if (route === "/channel/messages") return send(res, 200, { messages: channel.map((c, i) => ({ cursor: String(i + 1), id: String(i), created_at: new Date().toISOString(), reply_to: null, author: { name: c.author, kind: c.kind }, kind: c.kind === "system" ? "system" : "message", body: c.body, link: null })), cursor: String(channel.length), before: null, after: null });
  }
  if (req.method === "POST" && route === "/issues") {
    const i = { number: issues.length + 1, title: body.title, body: body.body ?? "", state: "open", labels: body.labels ?? [], created: new Date().toISOString(), author: "sami/cfos-gatekeeper" };
    issues.push(i);
    channel.push({ author: "sami/cfos-gatekeeper", kind: "system", body: `opened issue #${i.number} "${i.title}"` });
    return send(res, 201, issueJson(i));
  }
  if (req.method === "POST" && (m = route.match(/^\/issues\/(\d+)\/comments$/))) {
    comments.set(Number(m[1]), [...(comments.get(Number(m[1])) ?? []), body.body]);
    return send(res, 201, { id: 1, user: user("sami/cfos-gatekeeper"), body: body.body, created_at: "", html_url: "" });
  }
  if (req.method === "POST" && route === "/pulls") {
    if (!branches.has(body.head)) return send(res, 422, { message: `no branch ${body.head}` });
    const i = { number: issues.length + 1, title: body.title, body: body.body ?? "", state: "open", labels: [], created: new Date().toISOString(), author: "sami/cfos-gatekeeper", pull: { head: body.head, base: body.base } };
    issues.push(i);
    channel.push({ author: "sami/cfos-gatekeeper", kind: "system", body: `opened PR #${i.number} "${i.title}"` });
    return send(res, 201, pullJson(i));
  }
  if (req.method === "POST" && route === "/channel/messages") {
    channel.push({ author: "sami/cfos-gatekeeper", kind: "agent", body: body.body });
    return send(res, 201, { cursor: String(channel.length), id: "x", created_at: "", reply_to: null, author: { name: "sami/cfos-gatekeeper", kind: "agent" }, kind: "message", body: body.body, link: null });
  }
  if (req.method === "PATCH" && (m = route.match(/^\/issues\/(\d+)$/))) {
    const i = issues.find(x => x.number === Number(m[1]));
    if (!i) return send(res, 404, { message: "Not Found" });
    Object.assign(i, body);
    return send(res, 200, issueJson(i));
  }
  send(res, 404, { message: "Not Found" });
}).listen(PORT, "127.0.0.1", () => console.log(`fake gild on ${ORIGIN} for ${REPO}`));
