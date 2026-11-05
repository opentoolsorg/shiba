import { z } from "zod";
import { personalExecutionSnapshotSchema } from "@shiba/shared";
import { mintDaemonPairing } from "./computers-routes.js";
import { personalExecutionEnabled, resolvePersonalExecutionOwner, isPersonalOwnerCurrent, personalComputerRows, personalComputerMatches,
  canonicalPersonalRepository, isPublicPersonalRepository, createPersonalExecutionGrant, listPersonalExecutionGrants, revokePersonalExecutionGrant, resolvePersonalExecutionStopOwner, type PersonalExecutionEnv } from "./personal-execution-store.js";

const PREFIX = "/api/personal-execution";
const BODY_LIMIT = 8_192;
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const grantInput = z.strictObject({
  machineId: z.string().min(1).max(64), machineRevision: z.number().int().positive(),
  harness: z.enum(["claude-code", "codex"]), accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/), authVersion: z.string().regex(/^[a-f0-9]{64}$/),
  codingModel: z.string().min(1).max(200), repoUrl: z.string().max(512), expiresAt: z.number().int().positive(),
  consent: z.literal(true), hostingConsent: z.literal(true),
});

async function boundedBody(request: Request): Promise<unknown> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new Error("request_body_limit");
  if (!request.body) throw new Error("request_body_required");
  const reader = request.body.getReader(), buffer = new Uint8Array(BODY_LIMIT);
  let used = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.length > BODY_LIMIT) throw new Error("request_body_limit");
      buffer.set(chunk.value, used); used += chunk.value.length;
    }
    return JSON.parse(new TextDecoder().decode(buffer.subarray(0, used)));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function handlePersonalExecution(request: Request, env: PersonalExecutionEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!personalExecutionEnabled(env)) return respond({ error: "personal_execution_unavailable" }, 404);
  if (request.method !== "GET" && (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site" || request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json")) return respond({ error: "same_origin_json_required" }, 403);
  const forward = async (path: string, body: unknown) => {
    const response = await env.LocalDispatch!.get(env.LocalDispatch!.idFromName("local-dispatch"))
      .fetch(new Request(`https://local-dispatch/${path}`, { method: "POST", body: JSON.stringify(body) }));
    const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  };
  let body: unknown = {};
  if (request.method !== "GET") {
    try { body = await boundedBody(request); } catch { return respond({ error: "invalid_request" }, 400); }
  }
  const unpair = request.method === "DELETE" ? /^\/api\/personal-execution\/computers\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname) : null;
  if ((url.pathname === `${PREFIX}/harness/control` && request.method === "POST") || unpair) {
    const stopOwner = await resolvePersonalExecutionStopOwner(request, env);
    if (!stopOwner) return respond({ error: "verified_native_owner_required" }, 404);
    try {
      if (unpair) {
        const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(body);
        return await forward("revoke-personal-computer", { ...input, machineId: unpair[1], stopOwner });
      }
      const input = z.strictObject({ sandboxId: z.string().min(1).max(128), grantVersion: z.number().int().positive(),
        machineRevision: z.number().int().positive(), interrupt: z.literal(true) }).parse(body);
      return await forward("personal-harness-control", { ...input, stopOwner });
    } catch { return respond({ error: "personal_execution_stop_invalid" }, 400); }
  }
  const owner = await resolvePersonalExecutionOwner(request, env);
  if (!owner) return respond({ error: "verified_native_workspace_required" }, 404);
  let result: Response;
  try {
    if (url.pathname === `${PREFIX}/computers` && request.method === "GET") result = respond({ computers: await personalComputerRows(env, owner) });
    else if (url.pathname === `${PREFIX}/harness` && request.method === "GET") result = await forward("personal-harness", { scope: owner, canDecide: true });
    else if (url.pathname === `${PREFIX}/harness/decide` && request.method === "POST") {
      const input = z.strictObject({ sandboxId: z.string().min(1).max(128), requestId: z.string().min(1).max(128),
        actionHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive(), grantVersion: z.number().int().positive(),
        machineRevision: z.number().int().positive(), decision: z.enum(["allow", "deny"]) }).parse(body);
      result = await forward("personal-harness-decide", { ...input, scope: owner });
    }
    else if (url.pathname === `${PREFIX}/pairing-token` && request.method === "POST") {
      const selected = z.strictObject({ harness: z.enum(["claude-code", "codex"]), accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).parse(body);
      const minted = await mintDaemonPairing(env, url.origin, owner);
      result = minted.ok ? respond({ token: minted.token, expiresAt: minted.expiresAt,
        connectCommand: `${minted.command} --personal-harness ${selected.harness} --personal-billing native-subscription --personal-account ${selected.accountFingerprint}` }) : respond({ error: minted.message }, minted.status);
    } else if (url.pathname === `${PREFIX}/grants` && request.method === "GET") result = respond({ grants: await listPersonalExecutionGrants(env, owner) });
    else if (url.pathname === `${PREFIX}/grants` && request.method === "POST") {
      const input = grantInput.parse(body), repoUrl = canonicalPersonalRepository(input.repoUrl);
      const { consent: _consent, hostingConsent: _hosting, ...selection } = input;
      const candidate = personalExecutionSnapshotSchema.parse({ ...selection,
        version: 1, grantId: `plex_${"0".repeat(32)}`, grantVersion: 1, ownerAccountId: owner.ownerAccountId, actorId: owner.actorId,
        workspaceId: owner.workspaceId, membershipVersion: owner.membershipVersion, billingMode: "native-subscription", repoUrl, allowedPhases: ["local_repository_task"] });
      const computers = await personalComputerRows(env, owner);
      if (!computers.some((computer) => personalComputerMatches(computer, owner, candidate))) return respond({ error: "personal_account_or_computer_changed" }, 409);
      if (!await isPublicPersonalRepository(repoUrl)) return respond({ error: "public_repository_unavailable" }, 409);
      const snapshot = await createPersonalExecutionGrant(env, owner, { ...selection, repoUrl, billingMode: "native-subscription" });
      result = respond({ snapshot, status: "active", version: snapshot.grantVersion }, 201);
    } else {
      const match = /^\/api\/personal-execution\/(grants|computers)\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
      if (!match || request.method !== "DELETE") return respond({ error: "not_found" }, 404);
      if (match[1] === "grants") {
        const input = z.strictObject({ expectedVersion: z.number().int().positive() }).parse(body);
        if (!await revokePersonalExecutionGrant(env, owner, match[2]!, input.expectedVersion)) return respond({ error: "grant_changed_or_unavailable" }, 409);
        const cancelled = await forward("revoke-personal-grant", { scope: owner, grantId: match[2] });
        result = cancelled.ok ? respond({ revoked: true, version: input.expectedVersion + 1 }) : respond({ error: "revoked_queue_cancellation_pending", revoked: true }, 503);
      } else {
        const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(body);
        result = await forward("revoke-personal-computer", { scope: owner, machineId: match[2], expectedRevision: input.expectedRevision });
      }
    }
    return await isPersonalOwnerCurrent(env, owner) ? result : respond({ error: "workspace_authority_changed" }, 404);
  } catch {
    return respond({ error: "personal_execution_request_invalid_or_unavailable" }, 400);
  }
}
