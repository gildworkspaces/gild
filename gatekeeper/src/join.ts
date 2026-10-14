// gild's agent join flow, run by the gatekeeper on the user's behalf. This is the same protocol
// `gild agent join` speaks (gild-site lib/agentRequests.ts):
//
//   1. make an ed25519 key and file a request naming the sponsor, the one repository, and the
//      grants wanted there; gild answers with an approval link for the sponsor;
//   2. the sponsor (a person, or an approver agent of theirs) approves on gild.gg;
//   3. sign `gild-agent-join:<id>` and collect the API token, exactly once.
//
// No OAuth app, client secret or shared credential is involved: the private key never leaves the
// account Durable Object, and the token it collects is scoped by gild to that one repository.

import { GildApiError } from "./gild-api";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";

export const GRANTS = ["pr", "review", "queue"] as const;
export type Grant = (typeof GRANTS)[number];

export type PendingJoin = {
  requestId: string;
  agent: string;
  repo: string;
  grants: Grant[];
  approveUrl: string;
  publicKey: string;
  privateKeyPkcs8: string;
};

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function post<T>(origin: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await readTextCapped(response, 64 * 1024);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  if (!response.ok) {
    throw new GildApiError(response.status, String(data.message ?? data.error ?? `gild answered HTTP ${response.status}`).slice(0, 300));
  }
  return data as T;
}

/** Files the join request; returns what the account keeps until the sponsor decides. */
export async function fileJoin(origin: string, input: {
  sponsor: string; label: string; repo: string; grants: Grant[]; note: string;
}): Promise<PendingJoin> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = `ed25519:${b64(await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer)}`;
  const filed = await post<{ id: string; agent: string; approveUrl: string }>(origin, "/api/agents/requests", {
    sponsor: input.sponsor, label: input.label, publicKey, repo: input.repo, grants: input.grants, note: input.note,
  });
  return {
    requestId: filed.id, agent: filed.agent, repo: input.repo, grants: input.grants,
    approveUrl: filed.approveUrl, publicKey,
    privateKeyPkcs8: b64(await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer),
  };
}

export type CollectResult =
  | { status: "approved"; token: string; agent: string; repo: string | null; grants: string[] }
  | { status: "pending" | "denied" | "expired" };

/** Proves the key and collects the token once the sponsor has approved. */
export async function collectJoin(origin: string, join: PendingJoin): Promise<CollectResult> {
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(join.privateKeyPkcs8), c => c.charCodeAt(0)), { name: "Ed25519" }, false, ["sign"]);
  const signature = b64(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(`gild-agent-join:${join.requestId}`)));
  const data = await post<{ status: string; token?: string; name?: string; repo?: string | null; grants?: string[] }>(
    origin, `/api/agents/requests/${encodeURIComponent(join.requestId)}/token`, { signature });
  if (data.status === "approved" && data.token) {
    return { status: "approved", token: data.token, agent: data.name ?? join.agent, repo: data.repo ?? null, grants: data.grants ?? [] };
  }
  if (data.status === "denied" || data.status === "expired") return { status: data.status };
  return { status: "pending" };
}
