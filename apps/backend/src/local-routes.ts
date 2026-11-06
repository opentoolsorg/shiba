/**
 * `/api/local*` — the T51 operator daemon's self-authenticated surface:
 * the bearer check gates every verb before a byte reaches the dispatch DO.
 * NOT in SIGNATURE_AUTHENTICATED because it self-authenticates. Extracted
 * from index.ts.
 *   POST /api/local/claim    {operator?} → oldest pending envelope + claimToken
 *   POST /api/local/result   {sandboxId, claimToken, result} → settle
 *   GET  /api/local/status?sandboxId=    → record status + result
 *   GET  /api/local/pending              → pending/claimed inventory
 *   POST /api/local/heartbeat {machineId, hostname, …} → fleet upsert (T52)
 *   POST /api/local/events    {sandboxId, claimToken, event} → live transcript
 *   POST /api/local/approval  {sandboxId, claimToken, request|requestId}
 *   POST /api/local/control   {sandboxId, claimToken} → consume interrupt
 *   POST /api/local/pair      {pairingToken, …} → {adapterToken, machineId};
 *        NO bearer — the HMAC-signed, single-use pairing token is the credential.
 * Bearer is either the deployment's LOCAL_ADAPTER_TOKEN or a per-machine
 * adapter token minted by /pair (checked by hash; revoke → 401).
 * The Worker-side dispatch/cancel go through the DO stub directly — no
 * HTTP surface exists for minting work, only for claiming it.
 */
import { LOCAL_ADAPTER_TOKEN_ENV, LOCAL_RUNTIME_FLAG, PERSONAL_CONTROL_BODY_LIMIT, PERSONAL_EVENTS_BODY_LIMIT, PERSONAL_RESULT_BODY_LIMIT } from "@shiba/shared";
import { sha256Hex } from "./agent-tokens.js";
import { pairingSecret, verifyPairingToken } from "./computers-routes.js";
import type { Env } from "./env.js";
import { LOCAL_MACHINE_HEADER, LOCAL_ADAPTER_CALLER_HEADER, localDispatchStub } from "./local-dispatch.js";
import { decodeOrNull, HeartbeatRequestSchema, PairRequestSchema } from "./local-fleet-schema.js";
import { timingSafeEqualString } from "./security.js";
import { handleReasonNetworkCompanion } from "./reason-network/companion-routes.js";

export function isLocalRuntimePath(pathname: string): boolean {
  return pathname === "/api/local" || pathname.startsWith("/api/local/");
}

const DAEMON_VERBS = new Set([
  "claim",
  "result",
  "status",
  "pending",
  "heartbeat",
  "events",
  "approval",
  "control",
  "personal-account",
]);

const forwardJson = (stub: DurableObjectStub, path: string, body: unknown, headers: Record<string, string> = {}) =>
  stub.fetch(
    new Request(`https://local-dispatch/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

/** Personal machine tokens are an invited-user boundary, unlike the legacy operator bearer. */
async function boundedPersonalPost(request: Request, limit: number): Promise<Request | Response> {
  const denied = () => Response.json({ error: "personal_request_too_large", limit }, { status: 413 });
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return denied();
  if (!request.body) return request;
  const reader = request.body.getReader(), buffer = new Uint8Array(limit);
  let used = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.length > limit) return denied();
      buffer.set(chunk.value, used); used += chunk.value.length;
    }
    const headers = new Headers(request.headers); headers.delete("Content-Length");
    return new Request(request.url, { method: request.method, headers, body: buffer.subarray(0, used) });
  } finally { await reader.cancel().catch(() => {}); }
}

export async function handleLocalAdapter(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/local".length).replace(/^\/+|\/+$/g, "");
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const expected = env[LOCAL_ADAPTER_TOKEN_ENV]?.trim() || undefined;
  const secret = pairingSecret(env);
  if (expected === undefined && secret === undefined) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const stub = localDispatchStub(env);

  if (sub === "pair") {
    if (request.method !== "POST" || secret === undefined)
      return Response.json({ error: "Not found." }, { status: 404 });
    const pair = decodeOrNull(PairRequestSchema, await request.json().catch(() => null));
    if (pair === null) return Response.json({ error: "Invalid pair request." }, { status: 400 });
    const verified = await verifyPairingToken(secret, pair.pairingToken, Date.now());
    if (verified === null)
      return Response.json({ error: "Pairing token is invalid or expired." }, { status: 401 });
    if (verified.personalScope && verified.personalScope.origin !== url.origin) return Response.json({ error: "Pairing token belongs to another deployment origin." }, { status: 401 });
    return forwardJson(stub, "pair", { nonce: verified.nonce, pair, ...(verified.personalScope ? { personalScope: verified.personalScope } : {}) });
  }

  const presented = request.headers.get("authorization") ?? "";
  let machineId: string | undefined;
  let personalMachine = false;
  if (expected === undefined || !timingSafeEqualString(presented, `Bearer ${expected}`)) {
    const bearer = presented.startsWith("Bearer ") ? presented.slice("Bearer ".length).trim() : "";
    if (bearer === "") return Response.json({ error: "Unauthorized." }, { status: 401 });
    const authorized = await forwardJson(stub, "authorize", { tokenHash: await sha256Hex(bearer) });
    if (!authorized.ok) return Response.json({ error: "Unauthorized." }, { status: 401 });
    const identity = (await authorized.json()) as { machineId: string; personalExecution?: boolean };
    machineId = identity.machineId;
    personalMachine = identity.personalExecution === true;
  }
  if (personalMachine && !DAEMON_VERBS.has(sub)) return Response.json({ error: "Not found." }, { status: 404 });
  if (personalMachine && request.method === "POST") {
    const bounded = await boundedPersonalPost(request, sub === "result" ? PERSONAL_RESULT_BODY_LIMIT : sub === "events" ? PERSONAL_EVENTS_BODY_LIMIT : PERSONAL_CONTROL_BODY_LIMIT);
    if (bounded instanceof Response) return bounded;
    request = bounded;
  }
  if (sub.startsWith("reason-network/v1/")) return handleReasonNetworkCompanion(request, env, machineId);
  if (!DAEMON_VERBS.has(sub)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (sub === "heartbeat") {
    if (request.method !== "POST") return Response.json({ error: "Not found." }, { status: 404 });
    const heartbeat = decodeOrNull(HeartbeatRequestSchema, await request.json().catch(() => null));
    if (heartbeat === null) return Response.json({ error: "Invalid heartbeat." }, { status: 400 });
    // A per-machine token speaks only for its own machine.
    if (machineId !== undefined && heartbeat.machineId !== machineId) {
      return Response.json({ error: "Token was not issued to this machine." }, { status: 403 });
    }
    return forwardJson(stub, "heartbeat", heartbeat, { [LOCAL_ADAPTER_CALLER_HEADER]: "1", ...(machineId ? { [LOCAL_MACHINE_HEADER]: machineId } : {}) });
  }
  const forwarded = new Request(new URL(`https://local-dispatch/${sub}${url.search}`), request);
  forwarded.headers.delete(LOCAL_MACHINE_HEADER);
  forwarded.headers.delete(LOCAL_ADAPTER_CALLER_HEADER);
  forwarded.headers.set(LOCAL_ADAPTER_CALLER_HEADER, "1");
  if (machineId !== undefined) forwarded.headers.set(LOCAL_MACHINE_HEADER, machineId);
  return stub.fetch(forwarded);
}
