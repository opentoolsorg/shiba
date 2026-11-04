/**
 * `/api/runs` — the dashboard's run registry, proxied to the caller's
 * CodingOrchestrator DO (or a session DO when ?session= names one).
 * Extracted from index.ts; the per-surface Access gate stays here.
 */
import { getAgentByName } from "agents/routing";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_DASHBOARD, LOCAL_INTAKE_HEADER, isSafeDeliverablePath, MAX_DELIVERABLE_BYTES, type ExecutionTarget } from "@shiba/shared";
import type { Env } from "./env.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import { DASHBOARD_ORG_ID, resolveOrgForApiRequest, type ResolvedOrgAuth } from "./org-request-auth.js";
import { resolveTeamHandoffRunScope } from "./collaboration-run-scope.js";
import { collaborationExecutorIdentity } from "./collaboration-executor.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID } from "./collaboration-store.js";
import { isRestrictedTeamMember } from "./team-member-auth.js";
import { deliverableStorageKey } from "./run-deliverables.js";
import { signInternalRequest } from "./edge-identity.js";

import {
  isAccessConfigured,
  isAuthorizedRequest,
  isLoopbackRequest,
  resolveUserId,
} from "./request-auth.js";
import { sealRunEnv } from "./run-env-seal.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { resolveSkillPins } from "./skills-store.js";
import { onboardingRunFields } from "@shiba/shared";
import { resolveOnboardingTaskBinding } from "./onboarding-task-binding.js";
import {
  buildSessionAgentName,
  DEFAULT_SESSION_ID,
  isValidSessionId,
} from "./web-sessions.js";

/**
 * Which orchestrator DO holds the caller's run records: `?session=`/`?sessionId=`
 * resolves to that session's agent (verified against the user DO first);
 * absent — or the literal "default" — the caller's own user DO. Shared by
 * handleRuns and the /api/usage aggregate reader.
 */
export async function resolveRunStoreTarget(
  request: Request,
  env: Env,
  url: URL,
): Promise<{ agentName: string; userId: string } | { error: Response }> {
  const userId = await resolveUserId(request, env);
  const localAnonymous =
    userId === null &&
    !isAccessConfigured(env) &&
    !isBetterAuthConfigured(env) &&
    isLoopbackRequest(request);
  if (userId === null && !localAnonymous) {
    return { error: Response.json({ error: "Authentication required." }, { status: 401 }) };
  }
  const effectiveUserId = userId ?? "default";
  const executorPin = collaborationExecutorPins.get(request);
  if (executorPin) {
    const identity = collaborationExecutorIdentity({ tenantId: COLLAB_TENANT_ID,
      workspaceId: request.headers.get("X-Shiba-Workspace") ?? COLLAB_WORKSPACE_ID,
      senderUserId: effectiveUserId, executorAgentName: executorPin });
    if (!identity || identity.ownerId.trim().toLowerCase() !== effectiveUserId.trim().toLowerCase()) {
      return { error: Response.json({ error: "Handoff owner changed." }, { status: 403 }) };
    }
    return { agentName: identity.agentName, userId: effectiveUserId };
  }
  const sessionParam = url.searchParams.get("session") || url.searchParams.get("sessionId");
  if (sessionParam && sessionParam !== DEFAULT_SESSION_ID) {
    if (!isValidSessionId(sessionParam)) {
      return { error: Response.json({ error: "Invalid session id." }, { status: 400 }) };
    }
    const userStub = await getAgentByName(env.CodingOrchestrator, effectiveUserId);
    const sessionCheck = await userStub.fetch(
      `https://internal/internal/web-sessions/${encodeURIComponent(sessionParam)}`,
    );
    if (sessionCheck.status === 404) {
      return { error: Response.json({ error: "Session not found." }, { status: 404 }) };
    }
    if (!sessionCheck.ok) {
      return { error: Response.json({ error: "Failed to verify session." }, { status: sessionCheck.status }) };
    }
    const saved = await sessionCheck.json().catch(() => null) as { session?: { metadata?: unknown } } | null;
    if (!saved?.session || typeof saved.session !== "object")
      return { error: Response.json({ error: "Failed to verify session." }, { status: 503 }) };
    if (isTeamScopedRecord(saved.session.metadata))
      return { error: Response.json({ error: "Use the shared room to inspect team work." }, { status: 404 }) };
    return { agentName: buildSessionAgentName(effectiveUserId, sessionParam), userId: effectiveUserId };
  }
  return { agentName: effectiveUserId, userId: effectiveUserId };
}

type RunSummary = { runId: string; createdAt?: number };

function isTeamScopedRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (typeof row.orgId === "string" && row.orgId.startsWith("team:")) ||
    (typeof row.teamWorkspaceId === "string" && row.teamWorkspaceId.length > 0);
}

const collaborationExecutorPins = new WeakMap<Request, string>();
const collaborationProfilePins = new WeakMap<Request, number>();
const collaborationHandoffPins = new WeakMap<Request, string>();

/**
 * Automations, the review lane, Sentry and Slash runs live on the shared
 * "default" DO. Unscoped run reads by a DASHBOARD_APPROVERS member (the set
 * that can approve those runs) also read it; everyone else sees only their
 * own DO, so one user's runs never leak into another's list.
 */
async function withSharedRuns(
  env: Env,
  own: Response,
  runId: string | null,
  limitParam: string | null,
): Promise<Response> {
  const shared = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
  if (runId !== null) {
    if (own.status !== 404) return own;
    const fallback = await shared.fetch(`https://internal/api/runs/${encodeURIComponent(runId)}`);
    return fallback.ok ? fallback : own;
  }
  if (!own.ok) return own;
  const sharedRes = await shared.fetch(
    `https://internal/api/runs${limitParam !== null ? `?limit=${encodeURIComponent(limitParam)}` : ""}`,
  );
  if (!sharedRes.ok) return own;
  const mine = ((await own.json().catch(() => ({}))) as { runs?: RunSummary[] }).runs ?? [];
  const theirs = ((await sharedRes.json().catch(() => ({}))) as { runs?: RunSummary[] }).runs ?? [];
  const seen = new Set(mine.map((run) => run.runId));
  const merged = [...mine, ...theirs.filter((run) => !seen.has(run.runId))];
  // Same order contract as the DO: oldest-first, or newest-first when bounded.
  if (limitParam === null) {
    merged.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return Response.json({ runs: merged });
  }
  merged.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return Response.json({ runs: merged.slice(0, Math.min(Number(limitParam), 500)) });
}

export async function handleRuns(request: Request, env: Env): Promise<Response | null> {
  let res = await handleRunsInner(request, env);
  if (res === null) return null;
  // Team results require the room's current membership/source fence, including
  // for deployment operators whose user DO also retains private legacy work.
  if (request.method === "GET" && /^\/api\/runs(?:\/[^/]+)?$/.test(new URL(request.url).pathname) && res.ok) {
    const body = await res.clone().json().catch(() => null) as { runs?: unknown[]; run?: unknown } | null;
    if (body?.run && isTeamScopedRecord(body.run)) res = Response.json({ error: "Run not found. Use its shared room." }, { status: 404 });
    else if (Array.isArray(body?.runs) && body.runs.some(isTeamScopedRecord)) {
      const headers = new Headers(res.headers); headers.delete("content-length"); headers.delete("content-encoding");
      res = Response.json({ ...body, runs: body.runs.filter((run) => !isTeamScopedRecord(run)) }, { status: res.status, headers });
    }
  }
  // Run state is live: every response (errors included) is no-store; re-wrap since stub.fetch headers may be immutable.
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  return out;
}

/** Queue a room employee request through the normal approval-gated dashboard run route. */
export async function queueCollaborationRun(
  request: Request,
  env: Env,
  input: { task: string; repoUrl?: string; executionTarget?: ExecutionTarget; customAgentId: string; profileVersion: number; commandId: string; executorAgentName?: string; collaborationHandoffId?: string; runtime?: "sandbox" | "local"; targetMachineId?: string },
): Promise<Response | null> {
  if (env.BETTER_AUTH_SECRET && await isRestrictedTeamMember(request, env)) {
    return Response.json({ error: "Employee execution requires a deployment operator. Explicit personal-provider execution grants for invited team members are not available yet." },
      { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const forwarded = new Request(new URL("/api/runs", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify({ task: input.task, ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}), ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}), customAgentId: input.customAgentId, commandId: input.commandId, ...(input.runtime ? { runtime: input.runtime } : {}), ...(input.targetMachineId ? { targetMachineId: input.targetMachineId } : {}) }),
  });
  if (input.executorAgentName) collaborationExecutorPins.set(forwarded, input.executorAgentName);
  collaborationProfilePins.set(forwarded, input.profileVersion);
  if (input.collaborationHandoffId) collaborationHandoffPins.set(forwarded, input.collaborationHandoffId);
  return handleRuns(forwarded, env);
}

async function handleRunsInner(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  // /api/spine rides this lane: the orchestrator's P9 event log + outbox
  // live on the same DO, behind the same dashboard auth and session scope.
  const isSpine = url.pathname === "/api/spine";
  const taskPath = /^\/api\/tasks(?:\/[^/]+\/(?:retry|cancel))?$/.test(url.pathname);
  const employeeDraftPath = /^\/api\/employee-drafts(?:\/draft_[a-f0-9]{64}(?:\/(?:download|review))?)?$/.test(url.pathname);
  const deliverableMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/deliverables\/([^/]+)$/);
  const artifactActionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/deliverables\/([^/]+)\/(review|history|revision)$/);
  // The DO serves two-segment subroutes under /api/runs/<id>/: fork, screen.
  if (
    !isSpine &&
    !deliverableMatch &&
    !artifactActionMatch &&
    !taskPath &&
    !employeeDraftPath &&
    !/^\/api\/runs(?:\/[^/]+(?:\/(?:fork|screen|archive|steer|subagents))?|\/subagents\/spawn)?$/.test(
      url.pathname,
    )
  ) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  // Artifact/draft/history operations are already authenticated and resolve
  // their owner/session below. They do not accept an organization credential.
  // Organization resolution belongs to new intake and explicit team selectors.
  const requiresOrgScope = request.headers.has("X-Shiba-Workspace") ||
    (request.method === "POST" && url.pathname === "/api/runs");
  let orgAuth: ResolvedOrgAuth;
  if (requiresOrgScope) {
    const resolvedOrg = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
    if (resolvedOrg instanceof Response) return resolvedOrg;
    orgAuth = resolvedOrg;
  } else {
    // Explicit credentials never inherit the ambient human's owner DO.
    if (request.headers.has("authorization"))
      return Response.json({ error: "Human session required; API credentials cannot select private run ownership." }, { status: 403 });
    if (env.BETTER_AUTH_SECRET && await isRestrictedTeamMember(request, env))
      return Response.json({ error: "Select an active team workspace." }, { status: 403 });
    orgAuth = { orgId: DASHBOARD_ORG_ID, principal: null };
  }
  if (orgAuth.principal) return Response.json({ error: "Human session required." }, { status: 403 });
  // Team output/control uses the room's source-aware routes. The user's base
  // DO also contains legacy/private runs and is never a workspace registry.
  if (orgAuth.workspace && (request.method !== "POST" || url.pathname !== "/api/runs" || !collaborationHandoffPins.has(request))) {
    return Response.json({ error: "Use the shared room to request and inspect team employee work." }, { status: 403 });
  }
  if (employeeDraftPath) {
    const review = url.pathname.endsWith("/review");
    if (request.method !== (review ? "POST" : "GET")) {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
  }
  if (request.method === "POST" && (employeeDraftPath || artifactActionMatch)) {
    if (request.headers.get("origin") !== url.origin) {
      return Response.json({ error: "Same-origin request required." }, { status: 403 });
    }
  }
  if ((isSpine || deliverableMatch || artifactActionMatch?.[3] === "history") && request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if ((artifactActionMatch?.[3] === "review" || artifactActionMatch?.[3] === "revision") && request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const isSteer = /^\/api\/runs\/[^/]+\/steer$/.test(url.pathname);
  if (
    !isSpine &&
    request.method !== "GET" &&
    request.method !== "DELETE" &&
    request.method !== "POST"
  ) {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if (isSteer && request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) {
    return resolved.error;
  }
  let targetAgentName = resolved.agentName;
  // T68: seal per-run env values for the same DO the follow-up queue/chat lands on;
  // the sealed blob is the only form the values travel in from here.
  if (url.pathname === "/api/runs/env-seal") {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const body = (await request.json().catch(() => null)) as { environmentVariables?: unknown } | null;
    try {
      return Response.json(await sealRunEnv(env, resolved.agentName, body?.environmentVariables));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid environment variables." }, { status: 400 });
    }
  }
  let intakeBody: Record<string, unknown> | undefined;
  let intakeKind = "run";
  // Email-kind approvals freeze draft claims + mailbox payloads, and claim
  // recovery (releaseRestartedDraftClaim, sweepStaleDrafts, Slack resolve)
  // assumes they live on the one shared instance queueEmailApproval pins —
  // minting them on a per-user DO leaves a record no sweep can see.
  if (request.method === "POST" && url.pathname === "/api/runs") {
    const parsed: unknown = await request.clone().json().catch(() => null);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) intakeBody = parsed as Record<string, unknown>;
    if (typeof intakeBody?.kind === "string" && intakeBody.kind.trim()) intakeKind = intakeBody.kind.trim();
    if (
      url.pathname === "/api/runs" &&
      (intakeKind === "email_send" || intakeKind === "email_delete")
    ) {
      targetAgentName = ORCHESTRATOR_NAME;
    }
  }
  let rewritten = new Request(new URL(url.pathname + url.search, request.url), request);
  if (request.method === "POST" && url.pathname === "/api/runs" && intakeBody) {
    if (orgAuth.workspace) {
      const handoffId = collaborationHandoffPins.get(request)!;
      const profileVersion = collaborationProfilePins.get(request);
      const scope = await resolveTeamHandoffRunScope(env, {
        handoffId, actorId: resolved.userId, executorAgentName: resolved.agentName,
        employeeId: typeof intakeBody.customAgentId === "string" ? intakeBody.customAgentId : "",
        employeeVersion: profileVersion ?? 0, task: typeof intakeBody.task === "string" ? intakeBody.task : "",
        expectedWorkspaceId: orgAuth.workspace.workspaceId,
      });
      if (!scope || scope.orgId !== orgAuth.orgId)
        return Response.json({ error: "Team handoff authority changed. Create a new room request." }, { status: 403 });
    }
    if (intakeBody.onboardingSourceSnapshot !== undefined || intakeBody.onboardingTask !== undefined) {
      return Response.json({ error: "Onboarding source context is server-owned." }, { status: 400 });
    }
    let isOnboardingTask = false;
    try {
      const goal = await resolveOnboardingTaskBinding(env, resolved.userId, intakeBody.task, intakeBody, intakeBody.customAgentId);
      if (goal) {
        if (intakeKind !== "run") throw new Error("An onboarding goal can only bind a task run.");
        isOnboardingTask = true;
        intakeBody = { ...intakeBody, ...onboardingRunFields(goal), customAgentId: goal.customAgentId };
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid onboarding goal." }, { status: 409 });
    }
    if (Object.prototype.hasOwnProperty.call(intakeBody, "skillPins")) {
      const rawPins = intakeBody.skillPins;
      if (!Array.isArray(rawPins) || rawPins.length > 5 || rawPins.some((pin) =>
        typeof pin !== "object" || pin === null || Array.isArray(pin) ||
        typeof (pin as Record<string, unknown>).skillId !== "string" ||
        !Number.isSafeInteger((pin as Record<string, unknown>).version) ||
        Number((pin as Record<string, unknown>).version) < 1
      )) {
        return Response.json({ error: "Selected skills are invalid." }, { status: 400 });
      }
      const requested = rawPins.map((pin) => ({
        skillId: (pin as Record<string, unknown>).skillId as string,
        version: Number((pin as Record<string, unknown>).version),
      }));
      const resolvedSkills = await resolveSkillPins(env, orgAuth.orgId, resolved.userId, requested);
      if (!resolvedSkills) {
        return Response.json({ error: "A selected skill is unavailable or no longer active. Reload the Skills view and try again." }, { status: 409 });
      }
      const task = typeof intakeBody.task === "string" ? intakeBody.task.trim() : "";
      const effectiveTask = resolvedSkills.instructions && !isOnboardingTask ? `${task}\n\n${resolvedSkills.instructions}` : task;
      if (effectiveTask.length > 4000) {
        return Response.json(
          { error: "The complete task and selected skill instructions exceed the 4000-character limit. Shorten the task or deselect skills." },
          { status: 400 },
        );
      }
      intakeBody = {
        ...intakeBody,
        task: effectiveTask,
        skillPins: resolvedSkills.pins,
      };
    }
    // Dashboard run ownership comes from the verified user/session target,
    // never a client-provided key naming another or the shared DO's queue.
    const safeIntakeBody = { ...intakeBody };
    delete safeIntakeBody.customAgentVersion;
    delete safeIntakeBody.collaborationHandoffId;
    const trustedProfileVersion = collaborationProfilePins.get(request);
    const trustedCollaborationHandoffId = collaborationHandoffPins.get(request);
    rewritten = new Request(rewritten, {
      body: JSON.stringify({
        ...safeIntakeBody,
        orgId: orgAuth.orgId,
        ...(intakeKind === "run"
          ? {
              threadKey: (() => {
                const commandId =
                  typeof safeIntakeBody.commandId === "string" ? safeIntakeBody.commandId.trim() : "";
                const requested =
                  typeof safeIntakeBody.threadKey === "string" ? safeIntakeBody.threadKey.trim() : "";
                if (
                  requested.startsWith("acp:") &&
                  /^acp:[A-Za-z0-9-]+$/.test(requested) &&
                  commandId.startsWith(`${requested}:`)
                ) {
                  return requested;
                }
                return targetAgentName;
              })(),
            }
          : {}),
        ...(trustedProfileVersion !== undefined ? { customAgentVersion: trustedProfileVersion } : {}),
        ...(trustedCollaborationHandoffId !== undefined ? { collaborationHandoffId: trustedCollaborationHandoffId } : {}),
      }),
    });
    rewritten.headers.set("content-type", "application/json");
    rewritten.headers.delete("content-length");
  }
  // T51: the intake voucher. Any inbound copy is replaced by the only value
  // this Worker ever stamps — a run carrying `runtime: "local"` is provably
  // dashboard-originated when queueSlackRun reads this header. Internal
  // surfaces (Slack, email, MCP, automations) post through
  // `https://internal` and never carry it.
  rewritten.headers.delete(LOCAL_INTAKE_HEADER);
  rewritten.headers.set(LOCAL_INTAKE_HEADER, LOCAL_INTAKE_DASHBOARD);
  // Same strip for the agent-principal voucher: the DO reads queuedBy and
  // the /api/spine filter from this header as worker-vouched. Only
  // mcp-run-tools stamps it, on internal stub calls — never on this lane,
  // so an inbound copy is a forgery, not a credential to forward.
  rewritten.headers.delete(AGENT_PRINCIPAL_HEADER);
  // Edge identity: sign the stamped intake voucher so the DO can verify the
  // Worker minted it (no-op until INTERNAL_SIGNING_KEY is configured).
  await signInternalRequest(rewritten, env);
  // A new isolated team DO is not touched until all current handoff/source
  // checks pass. The address is intentionally absent from the private registry.
  const stub = await getAgentByName(env.CodingOrchestrator, targetAgentName);
  // Internal drafts belong only to this authenticated owner/session. Never
  // search the shared registry or another session for missing artifacts.
  if (employeeDraftPath) return stub.fetch(rewritten);
  if (artifactActionMatch) {
    let runId: string;
    let rawIndex: string;
    const encodedRunId = artifactActionMatch[1];
    const encodedIndex = artifactActionMatch[2];
    if (!encodedRunId || !encodedIndex) return Response.json({ error: "Invalid deliverable identity." }, { status: 400 });
    try {
      runId = decodeURIComponent(encodedRunId);
      rawIndex = decodeURIComponent(encodedIndex);
    } catch {
      return Response.json({ error: "Invalid deliverable identity." }, { status: 400 });
    }
    if (!/^(0|[1-7])$/.test(rawIndex)) return Response.json({ error: "Invalid deliverable index." }, { status: 400 });
    const lookup = new Request(new URL(`/api/runs/${encodeURIComponent(runId)}`, request.url), {
      method: "GET", headers: rewritten.headers,
    });
    lookup.headers.delete("content-length");
    await signInternalRequest(lookup, env);
    const found = await stub.fetch(lookup);
    if (!found.ok) return found;
    const saved = await found.json().catch(() => null) as { run?: unknown } | null;
    if (!saved?.run || isTeamScopedRecord(saved.run))
      return Response.json({ error: "Artifact not found. Use its shared room." }, { status: 404 });
    const forwarded = new Request(new URL(url.pathname + url.search, request.url), rewritten);
    await signInternalRequest(forwarded, env);
    return stub.fetch(forwarded);
  }
  if (deliverableMatch) {
    let runId: string;
    let index: number;
    try {
      runId = decodeURIComponent(deliverableMatch[1]!);
      const rawIndex = decodeURIComponent(deliverableMatch[2]!);
      if (!/^(0|[1-7])$/.test(rawIndex)) return Response.json({ error: "Invalid deliverable index." }, { status: 400 });
      index = Number(rawIndex);
    } catch {
      return Response.json({ error: "Invalid deliverable identity." }, { status: 400 });
    }
    // The verified owning session resolves the manifest. Never search other
    // sessions or fall back to the shared run registry for a download.
    const lookup = new Request(new URL(`/api/runs/${encodeURIComponent(runId)}`, request.url), rewritten);
    await signInternalRequest(lookup, env);
    const found = await stub.fetch(lookup);
    if (!found.ok) return found;
    const { run } = await found.json() as { run?: {
      status?: string; sandboxId?: string; expectedDeliverables?: string[];
      deliverables?: { path: string; mediaType: string; bytes: number; sha256: string }[];
    } };
    const item = run?.deliverables?.[index];
    if (isTeamScopedRecord(run) || run?.status !== "completed" || !run.sandboxId || !item || run.expectedDeliverables?.[index] !== item.path || !isSafeDeliverablePath(item.path) || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_DELIVERABLE_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      return Response.json({ error: "Deliverable not found." }, { status: 404 });
    }
    if (!env.ATTACHMENTS) return Response.json({ error: "Deliverable storage is unavailable." }, { status: 503 });
    const object = await env.ATTACHMENTS.get(deliverableStorageKey(run.sandboxId, item.sha256, index));
    if (!object) return Response.json({ error: "Deliverable not found." }, { status: 404 });
    if (object.size !== item.bytes) return Response.json({ error: "Deliverable integrity check failed." }, { status: 409 });
    const body = await object.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (body.byteLength !== item.bytes || hash !== item.sha256) return Response.json({ error: "Deliverable integrity check failed." }, { status: 409 });
    const types: Record<string, string> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8" };
    const mediaType = types[item.path.split(".").pop()!.toLowerCase()]!;
    return new Response(body, { headers: {
      "content-type": mediaType,
      "content-disposition": `attachment; filename="${item.path.split("/").pop()!}"`,
      "x-content-type-options": "nosniff",
      "content-length": String(item.bytes),
    } });
  }
  const response = await stub.fetch(rewritten);
  const runMatch = url.pathname.match(/^\/api\/runs(?:\/([^/]+))?$/);
  if (
    !isSpine &&
    request.method === "GET" &&
    runMatch &&
    targetAgentName === resolved.userId &&
    targetAgentName !== ORCHESTRATOR_NAME &&
    isApprover(resolved.userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))
  ) {
    let runId: string | null;
    try {
      runId = runMatch[1] ? decodeURIComponent(runMatch[1]) : null;
    } catch {
      return response;
    }
    return withSharedRuns(env, response, runId, url.searchParams.get("limit"));
  }
  return response;
}
