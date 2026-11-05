/**
 * T51: LocalDispatch — the single-writer mailbox a local run flows through.
 *
 *   Worker (LocalRuntimeAdapter)            operator daemon (`shiba local`)
 *   ──────────────────────────              ──────────────────────────
 *   POST /dispatch {envelope}   ──►   pending
 *                                   ◄──  POST /claim {operator}  → {claimToken, envelope}
 *   GET /status?sandboxId  polls        POST /result {sandboxId, claimToken, result}
 *   until settled
 *   POST /cancel on abort
 *
 * One DO, one request at a time: claim is the single serialized point that
 * keeps two daemons from executing the same run. The claimToken minted here
 * (never caller-supplied) is the result-write credential — a daemon that
 * didn't win the claim cannot settle the record.
 *
 * Auth lives at the Worker front door (handleLocalAdapter): every request
 * reaching this DO is already flag-gated and bearer-checked, or is a
 * Worker-internal call from the adapter (dispatch/status/cancel carry no
 * bearer — the DO trusts the intra-deployment channel the same way the
 * orchestrator's https://internal routes do).
 */
import {
  type ConnectedComputer,
  LOCAL_CLAIM_STALE_MS,
  LOCAL_COMPUTER_PRUNE_MS,
  LOCAL_DISPATCH_DO_NAME,
  LOCAL_HEARTBEAT_STALE_MS,
  type LocalDispatchRecord,
  type LocalDispatchStatus,
  localRunEnvelopeSchema,
  localRunResultSchema,
  personalPairingScopeSchema,
  personalAccountReceiptSchema,
  personalExecutionContextDigest,
  PERSONAL_ACCOUNT_MAX_AGE_MS,
  type PersonalPairingScope,
  type LocalRunEnvelope,
  redactSecrets,
} from "@shiba/shared";
import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "./agent-tokens.js";
import { decodeOrNull, HeartbeatRequestSchema, PairRequestSchema } from "./local-fleet-schema.js";
import { randomHex } from "./mailbox-store.js";
import type { Env } from "./env.js";
import { isPersonalOwnerCurrent, personalComputerMatches, personalGrantFence, isPublicPersonalRepository } from "./personal-execution-store.js";
import { validatePersonalExecutionClaim } from "./personal-execution-claim.js";

const RECORD_PREFIX = "run:";
const ARTIFACT_DISPATCH_PREFIX = "artifact-dispatched:";
const MAX_LOCAL_EVENT_BATCH = 64;
const MAX_SESSION_EVENTS = 200;
const COMPUTER_PREFIX = "computer:";
/** Locally runnable lane IDs mapped to the executable names the daemon probes. */
const LOCAL_DAEMON_HARNESSES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
};
/** `pair:<nonce>` → expiresAt; deleted on first use, so a pairing token mints once. */
const PAIR_PREFIX = "pair:";
/** Worker-vouched calling machine on /claim; local-routes strips any inbound copy. */
export const LOCAL_MACHINE_HEADER = "X-Shiba-Machine-Id";
export const LOCAL_ADAPTER_CALLER_HEADER = "X-Shiba-Adapter-Caller";
/** Dashboard harness routes stamp the authenticated owner for run-scoped control. */
export const LOCAL_DASHBOARD_OWNER_HEADER = "X-Shiba-Dashboard-Owner";
/** Set when the caller may operate shared harness approvals (DASHBOARD_APPROVERS). */
export const LOCAL_DASHBOARD_SHARED_HEADER = "X-Shiba-Dashboard-Shared";

/** Stored machine record: the adapter token lives only as its sha256 — never readable back. */
type ComputerRecord = Omit<ConnectedComputer, "status"> & { tokenHash?: string };

function toConnectedComputer(
  { tokenHash: _hash, ...record }: ComputerRecord,
  now: number,
): ConnectedComputer {
  const status =
    now - record.lastHeartbeat > LOCAL_HEARTBEAT_STALE_MS
      ? "offline"
      : record.activeRunId !== undefined
        ? "busy"
        : "idle";
  return { ...record, status };
}

export class LocalDispatch extends DurableObject<Env> {
  private async getRecord(sandboxId: string): Promise<LocalDispatchRecord | null> {
    return (
      (await this.ctx.storage.get<LocalDispatchRecord>(`${RECORD_PREFIX}${sandboxId}`)) ?? null
    );
  }

  private async putRecord(record: LocalDispatchRecord): Promise<void> {
    await this.ctx.storage.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, record);
  }

  private async deleteRecord(sandboxId: string): Promise<void> {
    await this.ctx.storage.delete(`${RECORD_PREFIX}${sandboxId}`);
  }

  /** The claim token is the write credential for live session traffic. */
  private harnessAllowed(
    record: LocalDispatchRecord,
    request: Request,
  ): boolean {
    if (record.envelope.personalExecution) return false;
    const owner = record.dashboardOwnerId;
    if (owner === undefined) return true;
    const caller = request.headers.get(LOCAL_DASHBOARD_OWNER_HEADER)?.trim() ?? "";
    if (caller === owner) return true;
    return request.headers.get(LOCAL_DASHBOARD_SHARED_HEADER) === "1";
  }

  private async claimedRecord(
    body: Record<string, unknown>,
  ): Promise<LocalDispatchRecord | Response> {
    const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
    const claimToken = typeof body.claimToken === "string" ? body.claimToken : "";
    const record = await this.getRecord(sandboxId);
    if (record === null) return Response.json({ error: "Run not found." }, { status: 404 });
    if (record.status !== "claimed" || record.claimToken !== claimToken || claimToken === "") {
      return Response.json(
        { error: `Run ${sandboxId} is not held by this claim.` },
        { status: 409 },
      );
    }
    return record;
  }

  /**
   * A claimed record whose holder never settled is reaped past the run
   * deadline — the daemon may have died mid-run; the run row reclaims on
   * its own clock either way.
   */
  private async reapStaleClaims(now: number): Promise<void> {
    const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
    for (const record of records.values()) {
      if (
        record.status === "claimed" &&
        record.claimedAt !== undefined &&
        now - record.claimedAt > LOCAL_CLAIM_STALE_MS
      ) {
        await this.putRecord({
          ...record,
          status: "cancelled",
          claimToken: undefined,
          settledAt: now,
        });
      }
      // Settled/cancelled records are audit tail — prune past 7 days.
      if (
        (record.status === "settled" || record.status === "cancelled") &&
        now - (record.settledAt ?? record.envelope.createdAt) > 7 * 24 * 60 * 60 * 1000
      ) {
        if (record.envelope.executionTarget?.kind === "artifact-workspace") {
          await this.ctx.storage.put(`${ARTIFACT_DISPATCH_PREFIX}${record.envelope.sandboxId}`, true);
        }
        await this.deleteRecord(record.envelope.sandboxId);
      }
    }
    const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
    for (const [key, computer] of computers) {
      if (now - computer.lastHeartbeat > LOCAL_COMPUTER_PRUNE_MS)
        await this.ctx.storage.delete(key);
    }
    const nonces = await this.ctx.storage.list<number | { expiresAt: number }>({ prefix: PAIR_PREFIX });
    for (const [key, value] of nonces) {
      const expiresAt = typeof value === "number" ? value : value.expiresAt;
      if (now > expiresAt) await this.ctx.storage.delete(key);
    }
  }

  private async personalDispatchCurrent(envelope: LocalRunEnvelope, computer: ComputerRecord, target: string): Promise<boolean> {
    try {
      const proof = envelope.personalExecution, binding = computer.personalExecution;
      if (!proof || !binding || target !== proof.snapshot.machineId || envelope.harness !== proof.snapshot.harness ||
        envelope.repoUrl !== proof.snapshot.repoUrl || envelope.orgId !== `team:${proof.snapshot.workspaceId}` ||
        !envelope.customAgentId || !envelope.customAgentVersion || envelope.setupCommands.length || envelope.configFiles.length || Object.keys(envelope.env).length || envelope.testCommand?.length ||
        !envelope.session || envelope.session.permissionMode !== "approval-required" || envelope.session.bin || envelope.session.binArgs?.length || envelope.session.resumeThreadId || envelope.session.reasoningEffort ||
        proof.contextDigest !== personalExecutionContextDigest({ ...envelope, handoffId: proof.handoffId }) ||
        envelope.session.provider !== (proof.snapshot.harness === "claude-code" ? "claude" : "codex") || envelope.session.model !== proof.snapshot.codingModel.split("/")[1] ||
        proof.approvedUntil <= Date.now() || proof.snapshot.expiresAt <= Date.now() || !personalComputerMatches(toConnectedComputer(computer, Date.now()), binding.scope, proof.snapshot)) return false;
      if (!await isPublicPersonalRepository(proof.snapshot.repoUrl) || !await validatePersonalExecutionClaim(this.env, proof)) return false;
      const current = await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${target}`);
      return Boolean(current?.personalExecution && personalComputerMatches(toConnectedComputer(current, Date.now()), binding.scope, proof.snapshot) &&
        await personalGrantFence(this.env, binding.scope, proof.snapshot) && proof.approvedUntil > Date.now() && proof.snapshot.expiresAt > Date.now());
    } catch { return false; }
  }

  private personalStopOwnerMatches(value: unknown, ownerAccountId: string, workspaceId: string): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const owner = value as Record<string, unknown>;
    return owner.ownerAccountId === ownerAccountId && owner.workspaceId === workspaceId && typeof owner.origin === "string" && owner.origin.startsWith("https://");
  }

  private async exactPersonalPermission(detail: string, actionHash: string, harness: string): Promise<boolean> {
    if (await sha256Hex(detail) !== actionHash) return false;
    try {
      const review = JSON.parse(detail) as Record<string, unknown>;
      if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).sort().join(",") !== "method,payload,provider,version" ||
        review.version !== 1 || !review.payload || typeof review.payload !== "object" || Array.isArray(review.payload)) return false;
      if (harness === "codex") return review.provider === "codex" && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"].includes(String(review.method));
      const payload = review.payload as { request?: { subtype?: unknown; tool_name?: unknown } };
      return harness === "claude-code" && review.provider === "claude" && review.method === "can_use_tool" && payload.request?.subtype === "can_use_tool" &&
        ["Bash", "Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"].includes(String(payload.request.tool_name));
    } catch { return false; }
  }

  private async json(request: Request): Promise<Record<string, unknown> | Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    return body as Record<string, unknown>;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    await this.reapStaleClaims(now);
    const machineId = request.headers.get(LOCAL_MACHINE_HEADER) ?? undefined;
    const machine = machineId ? await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${machineId}`) : undefined;
    if (["/result", "/events", "/approval", "/control"].includes(url.pathname)) {
      const body = await request.clone().json().catch(() => ({})) as { sandboxId?: unknown };
      const record = typeof body.sandboxId === "string" ? await this.getRecord(body.sandboxId) : null;
      if (record?.envelope.executionTarget?.kind === "artifact-workspace" &&
        (!machine?.tokenHash?.trim() || machine.personalExecution || record.targetMachineId !== machineId)) {
        return Response.json({ error: "Artifact claim requires its paired computer." }, { status: 403 });
      }
    }
    if (request.headers.get(LOCAL_ADAPTER_CALLER_HEADER) === "1" && ["/status", "/result", "/events", "/approval", "/control"].includes(url.pathname)) {
      const sandboxId = request.method === "GET" ? url.searchParams.get("sandboxId") : (await request.clone().json().catch(() => ({})) as { sandboxId?: unknown }).sandboxId;
      const record = typeof sandboxId === "string" ? await this.getRecord(sandboxId) : null;
      if ((record?.envelope.personalExecution && (!machine?.personalExecution || record.targetMachineId !== machineId)) ||
          (machine?.personalExecution && (!record?.envelope.personalExecution || record.targetMachineId !== machineId))) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      if (record?.envelope.personalExecution && machine?.personalExecution) {
        const proof = record.envelope.personalExecution;
        const current = personalComputerMatches(toConnectedComputer(machine, now), machine.personalExecution.scope, proof.snapshot) &&
          await validatePersonalExecutionClaim(this.env, proof) && await personalGrantFence(this.env, machine.personalExecution.scope, proof.snapshot) && proof.approvedUntil > Date.now();
        if (!current) {
          if (["pending", "claimed"].includes(record.status)) await this.putRecord({ ...record, status: "cancelled", claimToken: undefined, settledAt: now });
          return url.pathname === "/control" ? Response.json({ interrupt: true, reason: "Personal execution authority changed." }) : Response.json({ error: "Personal execution authority changed." }, { status: 409 });
        }
      }
    }

    if (request.method === "POST" && url.pathname === "/personal-computers") {
      const body = await this.json(request);
      if (body instanceof Response || !await isPersonalOwnerCurrent(this.env, body.scope)) return Response.json({ error: "Workspace unavailable." }, { status: 404 });
      const scope = personalPairingScopeSchema.parse(body.scope);
      const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
      return Response.json({ computers: [...computers.values()].map((row) => toConnectedComputer(row, now)).filter((row) => personalComputerMatches(row, scope)) });
    }
    if (request.method === "POST" && url.pathname === "/personal-account") {
      const body = await this.json(request);
      const parsed = body instanceof Response ? null : personalAccountReceiptSchema.safeParse(body.account);
      if (!machine?.personalExecution || !parsed?.success || !await isPersonalOwnerCurrent(this.env, machine.personalExecution.scope) || !this.ctx.storage.transaction) return Response.json({ error: "Personal machine unavailable." }, { status: 403 });
      if (Math.abs(now - parsed.data.probedAt) > PERSONAL_ACCOUNT_MAX_AGE_MS) return Response.json({ error: "Account observation is stale." }, { status: 409 });
      const updated = await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${machineId}`);
        if (!current?.personalExecution || current.tokenHash !== machine.tokenHash || !await isPersonalOwnerCurrent(this.env, current.personalExecution.scope)) return null;
        const prior = current.personalExecution.accounts.find((item) => item.harness === parsed.data.harness);
        if (prior && parsed.data.probedAt < prior.probedAt) return null;
        const changed = !prior || ["accountFingerprint", "authVersion", "cliVersion", "billingMode"].some((key) => prior[key as keyof typeof prior] !== parsed.data[key as keyof typeof parsed.data]);
        const revision = current.personalExecution.revision + (changed ? 1 : 0), receivedAt = Date.now();
        if (Math.abs(receivedAt - parsed.data.probedAt) > PERSONAL_ACCOUNT_MAX_AGE_MS) return null;
        await tx.put(`${COMPUTER_PREFIX}${machineId}`, { ...current, personalExecution: { ...current.personalExecution, revision,
          accounts: [...current.personalExecution.accounts.filter((item) => item.harness !== parsed.data.harness), { ...parsed.data, receivedAt }] } });
        if (changed) {
          const records = await tx.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
          for (const record of records.values()) {
            if (record.targetMachineId === machineId && record.envelope.personalExecution && ["pending", "claimed"].includes(record.status)) {
              await tx.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, { ...record, status: "cancelled", claimToken: undefined, settledAt: receivedAt });
            }
          }
        }
        return { observed: true, revision, receivedAt };
      });
      return updated ? Response.json(updated) : Response.json({ error: "Personal account observation changed." }, { status: 409 });
    }
    if (request.method === "POST" && ["/revoke-personal-computer", "/revoke-personal-grant"].includes(url.pathname)) {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      let scope: PersonalPairingScope;
      if (url.pathname === "/revoke-personal-computer") {
        if (!this.ctx.storage.transaction) return Response.json({ error: "Computer unavailable." }, { status: 503 });
        const removed = await this.ctx.storage.transaction(async (tx) => {
          const target = typeof body.machineId === "string" ? await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${body.machineId}`) : undefined;
          if (!target?.personalExecution || !this.personalStopOwnerMatches(body.stopOwner, target.personalExecution.scope.ownerAccountId, target.personalExecution.scope.workspaceId) ||
            target.personalExecution.scope.origin !== (body.stopOwner as { origin: string }).origin || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return null;
          await tx.delete(`${COMPUTER_PREFIX}${body.machineId}`);
          const records = await tx.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
          for (const record of records.values()) {
            if (record.targetMachineId === body.machineId && record.envelope.personalExecution && ["pending", "claimed"].includes(record.status))
              await tx.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, { ...record, status: "cancelled", claimToken: undefined, settledAt: Date.now() });
          }
          return true;
        });
        return removed ? Response.json({ revoked: true }) : Response.json({ error: "Computer unavailable." }, { status: 404 });
      } else {
        if (!await isPersonalOwnerCurrent(this.env, body.scope)) return Response.json({ error: "Workspace unavailable." }, { status: 404 });
        scope = personalPairingScopeSchema.parse(body.scope);
      }
      const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      for (const record of records.values()) {
        const snapshot = record.envelope.personalExecution?.snapshot;
        if (snapshot?.ownerAccountId === scope.ownerAccountId && snapshot.workspaceId === scope.workspaceId &&
          snapshot.grantId === body.grantId && ["pending", "claimed"].includes(record.status)) {
          await this.putRecord({ ...record, status: "cancelled", claimToken: undefined, settledAt: now });
        }
      }
      return Response.json({ revoked: true });
    }

    if (request.method === "POST" && url.pathname === "/personal-harness-control") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      if (!this.ctx.storage.transaction || typeof body.sandboxId !== "string" || body.interrupt !== true) return Response.json({ error: "Stop unavailable." }, { status: 400 });
      const stopped = await this.ctx.storage.transaction(async (tx) => {
        const record = await tx.get<LocalDispatchRecord>(`${RECORD_PREFIX}${body.sandboxId}`), proof = record?.envelope.personalExecution;
        const computer = record ? await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${record.targetMachineId}`) : undefined;
        if (!record || !proof || !["pending", "claimed"].includes(record.status) || !this.personalStopOwnerMatches(body.stopOwner, proof.snapshot.ownerAccountId, proof.snapshot.workspaceId) ||
          !computer?.personalExecution || computer.personalExecution.scope.ownerAccountId !== proof.snapshot.ownerAccountId ||
          computer.personalExecution.scope.workspaceId !== proof.snapshot.workspaceId || computer.personalExecution.scope.origin !== (body.stopOwner as { origin: string }).origin ||
          proof.snapshot.grantVersion !== body.grantVersion || proof.snapshot.machineRevision !== body.machineRevision) return false;
        await tx.put(`${RECORD_PREFIX}${body.sandboxId}`, { ...record, status: "cancelled", interrupt: true, claimToken: undefined, settledAt: Date.now() });
        return true;
      });
      return stopped ? Response.json({ ok: true }) : Response.json({ error: "Run unavailable." }, { status: 404 });
    }

    if (request.method === "POST" && ["/personal-harness", "/personal-harness-decide"].includes(url.pathname)) {
      const body = await this.json(request);
      if (body instanceof Response || !await isPersonalOwnerCurrent(this.env, body.scope)) return Response.json({ error: "Workspace unavailable." }, { status: 404 });
      const scope = personalPairingScopeSchema.parse(body.scope);
      if (url.pathname === "/personal-harness") {
        const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX }), runs = [];
        for (const record of records.values()) {
          const proof = record.envelope.personalExecution;
          if (record.status !== "claimed" || !proof || proof.snapshot.ownerAccountId !== scope.ownerAccountId || proof.snapshot.workspaceId !== scope.workspaceId) continue;
          const computer = await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${record.targetMachineId}`);
          if (!computer || !await this.personalDispatchCurrent(record.envelope, computer, record.targetMachineId ?? "")) {
            runs.push({ sandboxId: record.envelope.sandboxId, events: [], diff: "", approvals: [], grantVersion: proof.snapshot.grantVersion,
              machineRevision: proof.snapshot.machineRevision, canInterrupt: true, canAllow: false, canDeny: false });
            continue;
          }
          runs.push({ sandboxId: record.envelope.sandboxId, events: record.sessionEvents ?? [], diff: record.liveDiff ?? "", approvals: (record.harnessApprovals ?? []).map((item) => ({ ...item, reviewIncomplete: false })),
            grantVersion: proof.snapshot.grantVersion, machineRevision: proof.snapshot.machineRevision, canInterrupt: true, canAllow: body.canDecide === true, canDeny: body.canDecide === true });
        }
        return Response.json({ runs });
      }
      const record = typeof body.sandboxId === "string" ? await this.getRecord(body.sandboxId) : null, proof = record?.envelope.personalExecution;
      const computer = record ? await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${record.targetMachineId}`) : undefined;
      if (!record || !proof || !computer || proof.snapshot.ownerAccountId !== scope.ownerAccountId || proof.snapshot.workspaceId !== scope.workspaceId ||
        !await this.personalDispatchCurrent(record.envelope, computer, record.targetMachineId ?? "") || !this.ctx.storage.transaction) return Response.json({ error: "Permission unavailable." }, { status: 404 });
      const decided = await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<LocalDispatchRecord>(`${RECORD_PREFIX}${body.sandboxId}`), currentProof = current?.envelope.personalExecution;
        const currentComputer = current ? await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${current.targetMachineId}`) : undefined;
        const item = current?.harnessApprovals?.find((item) => item.requestId === body.requestId);
        if (!current || current.status !== "claimed" || !currentProof || !currentComputer?.personalExecution || !item || item.decision || item.consumedAt ||
          !item.actionHash || item.actionHash !== body.actionHash || item.expiresAt !== body.expiresAt || !item.expiresAt || item.expiresAt <= Date.now() ||
          currentProof.snapshot.grantVersion !== body.grantVersion || currentProof.snapshot.machineRevision !== body.machineRevision ||
          !personalComputerMatches(toConnectedComputer(currentComputer, Date.now()), scope, currentProof.snapshot) || !await personalGrantFence(this.env, scope, currentProof.snapshot) ||
          currentProof.approvedUntil <= Date.now() || item.expiresAt <= Date.now() || (body.decision !== "allow" && body.decision !== "deny")) return false;
        await tx.put(`${RECORD_PREFIX}${body.sandboxId}`, { ...current, harnessApprovals: current.harnessApprovals!.map((item) => item.requestId === body.requestId ? { ...item, decision: body.decision } : item) });
        return true;
      });
      return decided ? Response.json({ ok: true, actionHash: body.actionHash, expiresAt: body.expiresAt }) : Response.json({ error: "Permission changed or already decided." }, { status: 409 });
    }

    if (request.method === "POST" && url.pathname === "/dispatch") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const parsed = localRunEnvelopeSchema.safeParse(body.envelope);
      if (!parsed.success) {
        return Response.json({ error: "Invalid run envelope." }, { status: 400 });
      }
      const existing = await this.getRecord(parsed.data.sandboxId);
      const artifact = parsed.data.executionTarget?.kind === "artifact-workspace";
      if ((existing && (artifact || existing.envelope.executionTarget?.kind === "artifact-workspace")) ||
        await this.ctx.storage.get(`${ARTIFACT_DISPATCH_PREFIX}${parsed.data.sandboxId}`)) {
        return Response.json({ error: "Local artifact execution was already dispatched; create a new approval instead of retrying." }, { status: 409 });
      }
      if (existing && parsed.data.personalExecution) return Response.json({ error: "Personal execution was already dispatched." }, { status: 409 });
      if (existing !== null && existing.status !== "settled" && existing.status !== "cancelled") {
        return Response.json(
          { error: `Run ${parsed.data.sandboxId} is already ${existing.status}.` },
          { status: 409 },
        );
      }
      if (body.targetMachineId !== undefined && typeof body.targetMachineId !== "string") {
        return Response.json({ error: "Invalid targetMachineId." }, { status: 400 });
      }
      const target = typeof body.targetMachineId === "string" ? body.targetMachineId.trim() : "";
      if (target.length > 128)
        return Response.json({ error: "Invalid targetMachineId." }, { status: 400 });
      if (target !== "") {
        const computer = await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${target}`);
        // Shared-token heartbeats can publish a fleet row without pairing.
        // Such a row has no machine credential with which to claim a pin.
        if (!computer || typeof computer.tokenHash !== "string" || !computer.tokenHash.trim()) {
          return Response.json({ error: "Target computer is not paired or was revoked." }, { status: 404 });
        }
        const proof = parsed.data.personalExecution;
        if (Boolean(computer.personalExecution) !== Boolean(proof)) return Response.json({ error: "Personal and operator execution cannot share a computer." }, { status: 403 });
        if (proof && (!await this.personalDispatchCurrent(parsed.data, computer, target) || body.dashboardOwnerId !== proof.snapshot.actorId)) return Response.json({ error: "Personal execution authority is unavailable." }, { status: 403 });
        if (!Number.isFinite(computer.lastHeartbeat) || Math.abs(now - computer.lastHeartbeat) > LOCAL_HEARTBEAT_STALE_MS) {
          return Response.json({ error: "Target computer is offline. Reconnect it before dispatching." }, { status: 409 });
        }
        const daemonHarness = LOCAL_DAEMON_HARNESSES[parsed.data.harness];
        if (!daemonHarness || !computer.harnesses.includes(daemonHarness)) {
          return Response.json({ error: "Target computer does not support this harness." }, { status: 409 });
        }
        // A live busy machine can claim this pending run after its current
        // run settles. Only availability and compatibility gate dispatch.
      }
      if (parsed.data.personalExecution && !target) return Response.json({ error: "Personal execution requires its exact computer." }, { status: 403 });
      const dashboardOwnerId =
        typeof body.dashboardOwnerId === "string" && body.dashboardOwnerId.trim() !== ""
          ? body.dashboardOwnerId.trim().slice(0, 200)
          : undefined;
      if (artifact && (!target || !dashboardOwnerId)) return Response.json({ error: "Local artifacts require a paired computer and owner." }, { status: 403 });
      const record: LocalDispatchRecord = {
        envelope: parsed.data,
        status: "pending",
        ...(target !== "" ? { targetMachineId: target } : {}),
        ...(dashboardOwnerId !== undefined ? { dashboardOwnerId } : {}),
      };
      if (parsed.data.personalExecution) {
        if (!this.ctx.storage.transaction) return Response.json({ error: "Personal dispatch storage unavailable." }, { status: 503 });
        const inserted = await this.ctx.storage.transaction(async (tx) => {
          if (await tx.get(`${RECORD_PREFIX}${parsed.data.sandboxId}`)) return false;
          const current = await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${target}`), proof = parsed.data.personalExecution!;
          if (!current?.personalExecution || !personalComputerMatches(toConnectedComputer(current, Date.now()), current.personalExecution.scope, proof.snapshot) ||
            !await personalGrantFence(this.env, current.personalExecution.scope, proof.snapshot) || proof.approvedUntil <= Date.now()) return false;
          await tx.put(`${RECORD_PREFIX}${parsed.data.sandboxId}`, record);
          return true;
        });
        return inserted ? Response.json({ ok: true }) : Response.json({ error: "Personal dispatch changed or already exists." }, { status: 409 });
      }
      if (artifact) {
        if (!this.ctx.storage.transaction) return Response.json({ error: "Artifact dispatch storage unavailable." }, { status: 503 });
        const inserted = await this.ctx.storage.transaction(async (tx) => {
          const fence = `${ARTIFACT_DISPATCH_PREFIX}${parsed.data.sandboxId}`;
          if (await tx.get(fence) || await tx.get(`${RECORD_PREFIX}${parsed.data.sandboxId}`)) return false;
          const computer = await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${target}`);
          if (!computer?.tokenHash?.trim() || computer.personalExecution || !Number.isFinite(computer.lastHeartbeat) ||
            Math.abs(Date.now() - computer.lastHeartbeat) > LOCAL_HEARTBEAT_STALE_MS ||
            !computer.harnesses.includes(LOCAL_DAEMON_HARNESSES[parsed.data.harness] ?? "")) return false;
          // Keep a small replay fence after the bounded run audit record is pruned.
          await tx.put(fence, true);
          await tx.put(`${RECORD_PREFIX}${parsed.data.sandboxId}`, record);
          return true;
        });
        return inserted ? Response.json({ ok: true }) : Response.json({ error: "Artifact execution was already dispatched." }, { status: 409 });
      }
      await this.putRecord(record);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const operator = typeof body.operator === "string" ? body.operator.slice(0, 200) : undefined;
      // Shared-token callers carry no machine identity and keep claiming anything.
      const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      const pending = [...records.values()]
        .filter((record) => record.status === "pending")
        .filter((record) => record.envelope.executionTarget?.kind !== "artifact-workspace" ||
          Boolean(machine?.tokenHash?.trim() && !machine.personalExecution && record.targetMachineId === machineId))
        .filter((record) => machine?.personalExecution
          ? Boolean(record.envelope.personalExecution && record.targetMachineId === machineId)
          : !record.envelope.personalExecution)
        // Pinned runs need a per-machine token: no vouched id means unpinned only.
        .filter(
          (record) => record.targetMachineId === undefined || record.targetMachineId === machineId,
        )
        .sort((a, b) => a.envelope.createdAt - b.envelope.createdAt)[0];
      if (pending === undefined) {
        return Response.json({ envelope: null });
      }
      if (pending.envelope.personalExecution) {
        if (!machine || !await this.personalDispatchCurrent(pending.envelope, machine, machineId ?? "") || !this.ctx.storage.transaction) return Response.json({ error: "Personal execution authority changed." }, { status: 409 });
        const claimed = await this.ctx.storage.transaction(async (tx) => {
          const current = await tx.get<LocalDispatchRecord>(`${RECORD_PREFIX}${pending.envelope.sandboxId}`);
          const computer = await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${machineId}`);
          const proof = current?.envelope.personalExecution;
          if (!current || current.status !== "pending" || !proof || !computer?.personalExecution || current.targetMachineId !== machineId ||
            !personalComputerMatches(toConnectedComputer(computer, Date.now()), computer.personalExecution.scope, proof.snapshot) ||
            !await personalGrantFence(this.env, computer.personalExecution.scope, proof.snapshot) || proof.approvedUntil <= Date.now()) return null;
          const claimToken = crypto.randomUUID();
          await tx.put(`${RECORD_PREFIX}${current.envelope.sandboxId}`, { ...current, status: "claimed", claimToken, claimedAt: Date.now() });
          return { envelope: current.envelope, claimToken };
        });
        return claimed ? Response.json(claimed) : Response.json({ error: "Personal execution claim changed." }, { status: 409 });
      }
      // Minted here, never accepted from the caller — the token is the
      // proof the settle side holds that this claim won the race.
      const claimToken = crypto.randomUUID();
      await this.putRecord({
        ...pending,
        status: "claimed",
        claimToken,
        claimedAt: now,
        ...(operator !== undefined ? { claimedBy: operator } : {}),
      });
      return Response.json({ envelope: pending.envelope, claimToken });
    }

    if (request.method === "POST" && url.pathname === "/result") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
      const claimToken = typeof body.claimToken === "string" ? body.claimToken : "";
      const record = await this.getRecord(sandboxId);
      if (record === null) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      if (record.status !== "claimed" || record.claimToken !== claimToken || claimToken === "") {
        return Response.json(
          { error: `Run ${sandboxId} is not held by this claim.` },
          { status: 409 },
        );
      }
      const parsed = localRunResultSchema.safeParse(body.result);
      if (!parsed.success) {
        return Response.json({ error: "Invalid run result." }, { status: 400 });
      }
      await this.putRecord({ ...record, status: "settled", result: parsed.data, settledAt: now });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
      const record = await this.getRecord(sandboxId);
      if (record === null) return Response.json({ error: "Run not found." }, { status: 404 });
      if (record.status === "settled" || record.status === "cancelled") {
        return Response.json({ ok: true, status: record.status });
      }
      await this.putRecord({
        ...record,
        status: "cancelled",
        claimToken: undefined,
        settledAt: now,
      });
      return Response.json({ ok: true, status: "cancelled" as LocalDispatchStatus });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const sandboxId = url.searchParams.get("sandboxId") ?? "";
      const record = await this.getRecord(sandboxId);
      if (record === null) return Response.json({ error: "Run not found." }, { status: 404 });
      return Response.json({
        status: record.status,
        ...(record.claimedAt !== undefined
          ? { claimedAt: record.claimedAt, claimedBy: record.claimedBy }
          : {}),
        ...(record.result !== undefined ? { result: record.result } : {}),
        ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
        ...(record.sessionEvents !== undefined ? { sessionEvents: record.sessionEvents } : {}),
        ...(record.liveDiff !== undefined ? { liveDiff: record.liveDiff } : {}),
      });
    }

    if (request.method === "GET" && url.pathname === "/pending") {
      const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      const pending = [...records.values()]
        .filter((record) => record.status === "pending" || record.status === "claimed")
        .filter((record) => machine?.personalExecution ? Boolean(record.envelope.personalExecution && record.targetMachineId === machineId) : !record.envelope.personalExecution)
        .map((record) => ({
          sandboxId: record.envelope.sandboxId,
          status: record.status,
          harness: record.envelope.harness,
          createdAt: record.envelope.createdAt,
          ...(record.claimedAt !== undefined ? { claimedAt: record.claimedAt } : {}),
        }));
      return Response.json({ pending });
    }

    // ── T52 fleet: every verb below is reached only after the Worker route
    // verified the caller (pairing-token HMAC, daemon bearer, or dashboard auth).

    if (request.method === "POST" && url.pathname === "/pairing-nonce") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      if (
        typeof body.nonce !== "string" ||
        body.nonce === "" ||
        typeof body.expiresAt !== "number"
      ) {
        return Response.json({ error: "Invalid pairing nonce." }, { status: 400 });
      }
      if (body.personalScope !== undefined && !await isPersonalOwnerCurrent(this.env, body.personalScope)) return Response.json({ error: "Personal ownership unavailable." }, { status: 403 });
      await this.ctx.storage.put(`${PAIR_PREFIX}${body.nonce}`, body.personalScope ? { expiresAt: body.expiresAt, personalScope: personalPairingScopeSchema.parse(body.personalScope) } : body.expiresAt);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      const saved = nonce === "" ? undefined : await this.ctx.storage.get<number | { expiresAt: number; personalScope: PersonalPairingScope }>(`${PAIR_PREFIX}${nonce}`);
      const expiresAt = typeof saved === "number" ? saved : saved?.expiresAt;
      if (expiresAt === undefined || now > expiresAt) {
        return Response.json(
          { error: "Pairing token is expired or already used." },
          { status: 401 },
        );
      }
      const pair = decodeOrNull(PairRequestSchema, body.pair);
      if (pair === null) return Response.json({ error: "Invalid pair request." }, { status: 400 });
      if (typeof saved === "object") {
        if (JSON.stringify(saved.personalScope) !== JSON.stringify(body.personalScope) || !await isPersonalOwnerCurrent(this.env, saved.personalScope) || !this.ctx.storage.transaction) return Response.json({ error: "Personal ownership changed." }, { status: 403 });
        const machineId = crypto.randomUUID(), adapterToken = randomHex(32);
        const tokenHash = await sha256Hex(adapterToken);
        const paired = await this.ctx.storage.transaction(async (tx) => {
          const current = await tx.get(`${PAIR_PREFIX}${nonce}`);
          if (JSON.stringify(current) !== JSON.stringify(saved) || !await isPersonalOwnerCurrent(this.env, saved.personalScope) || saved.expiresAt <= Date.now()) return false;
          await tx.delete(`${PAIR_PREFIX}${nonce}`);
          await tx.put(`${COMPUTER_PREFIX}${machineId}`, { machineId, hostname: pair.hostname, platform: pair.platform, daemonVersion: pair.daemonVersion,
            harnesses: [...pair.harnesses], lastHeartbeat: now, pairedAt: now, tokenHash,
            personalExecution: { version: 1, revision: 1, scope: saved.personalScope, accounts: [] } });
          return true;
        });
        if (!paired) return Response.json({ error: "Pairing token already used." }, { status: 401 });
        return Response.json({ adapterToken, machineId, personalExecution: { version: 1, scope: saved.personalScope } });
      }
      if (body.personalScope !== undefined) return Response.json({ error: "Invalid pairing scope." }, { status: 401 });
      await this.ctx.storage.delete(`${PAIR_PREFIX}${nonce}`);
      const machineId = crypto.randomUUID();
      const adapterToken = randomHex(32);
      const record: ComputerRecord = {
        machineId,
        hostname: pair.hostname,
        platform: pair.platform,
        daemonVersion: pair.daemonVersion,
        harnesses: [...pair.harnesses],
        lastHeartbeat: now,
        pairedAt: now,
        tokenHash: await sha256Hex(adapterToken),
      };
      await this.ctx.storage.put(`${COMPUTER_PREFIX}${machineId}`, record);
      return Response.json({ adapterToken, machineId });
    }

    if (request.method === "POST" && url.pathname === "/authorize") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const tokenHash = typeof body.tokenHash === "string" ? body.tokenHash : "";
      // ponytail: linear scan of the fleet per daemon call; add a `token:<hash>` index if fleets grow past dozens.
      const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
      const match = [...computers.values()].find(
        (computer) => tokenHash !== "" && computer.tokenHash === tokenHash,
      );
      if (match === undefined) return Response.json({ error: "Unauthorized." }, { status: 401 });
      if (match.personalExecution && !await isPersonalOwnerCurrent(this.env, match.personalExecution.scope)) return Response.json({ error: "Personal workspace access changed." }, { status: 401 });
      return Response.json({ machineId: match.machineId, ...(match.personalExecution ? { personalExecution: true } : {}) });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const heartbeat = decodeOrNull(HeartbeatRequestSchema, body);
      if (heartbeat === null)
        return Response.json({ error: "Invalid heartbeat." }, { status: 400 });
      const existing = await this.ctx.storage.get<ComputerRecord>(
        `${COMPUTER_PREFIX}${heartbeat.machineId}`,
      );
      if (machineId && !existing) return Response.json({ error: "Computer was revoked." }, { status: 409 });
      if (existing?.personalExecution && request.headers.get(LOCAL_MACHINE_HEADER) !== heartbeat.machineId) return Response.json({ error: "Personal computer token required." }, { status: 403 });
      if (existing?.personalExecution) {
        if (!this.ctx.storage.transaction) return Response.json({ error: "Computer storage unavailable." }, { status: 503 });
        const updated = await this.ctx.storage.transaction(async (tx) => {
          const current = await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${heartbeat.machineId}`);
          if (!current?.personalExecution || current.tokenHash !== existing.tokenHash || !await isPersonalOwnerCurrent(this.env, current.personalExecution.scope)) return false;
          await tx.put(`${COMPUTER_PREFIX}${heartbeat.machineId}`, { ...current,
            hostname: heartbeat.hostname, platform: heartbeat.platform, daemonVersion: heartbeat.daemonVersion, harnesses: [...heartbeat.harnesses],
            lastHeartbeat: Date.now(), activeRunId: heartbeat.activeRunId });
          return true;
        });
        return updated ? Response.json({ ok: true }) : Response.json({ error: "Computer authority changed." }, { status: 409 });
      }
      const record: ComputerRecord = {
        machineId: heartbeat.machineId,
        hostname: heartbeat.hostname,
        platform: heartbeat.platform,
        daemonVersion: heartbeat.daemonVersion,
        harnesses: [...heartbeat.harnesses],
        lastHeartbeat: now,
        ...(existing?.pairedAt !== undefined ? { pairedAt: existing.pairedAt } : {}),
        ...(heartbeat.activeRunId !== undefined ? { activeRunId: heartbeat.activeRunId } : {}),
        ...(heartbeat.reasonNetworkCompanion !== undefined ? { reasonNetworkCompanion: heartbeat.reasonNetworkCompanion } : {}),
        ...(existing?.tokenHash !== undefined ? { tokenHash: existing.tokenHash } : {}),
        ...(existing?.personalExecution ? { personalExecution: existing.personalExecution } : {}),
      };
      await this.ctx.storage.put(`${COMPUTER_PREFIX}${heartbeat.machineId}`, record);
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/computers") {
      const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
      const list = [...computers.values()]
        .filter((computer) => !computer.personalExecution)
        .map((computer) => toConnectedComputer(computer, now))
        .sort((a, b) => b.lastHeartbeat - a.lastHeartbeat);
      return Response.json({ computers: list });
    }

    if (request.method === "POST" && url.pathname === "/events") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const held = await this.claimedRecord(body);
      if (held instanceof Response) return held;
      const incoming = Array.isArray(body.events)
        ? body.events
        : body.event !== undefined
          ? [body.event]
          : [];
      if (incoming.length > MAX_LOCAL_EVENT_BATCH) {
        return Response.json(
          { error: `At most ${MAX_LOCAL_EVENT_BATCH} events per request.` },
          { status: 400 },
        );
      }
      let events = [...(held.sessionEvents ?? [])];
      let liveDiff = held.liveDiff;
      let next = events.reduce((max, event) => Math.max(max, event.seq), 0);
      for (const item of incoming) {
        if (item === null || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        next += 1;
        events.push({
          seq: next,
          at: now,
          type: typeof row.type === "string" ? row.type.slice(0, 64) : "event",
          text: typeof row.text === "string" ? row.text.slice(0, 500) : "",
        });
        if (typeof row.patch === "string" && row.patch !== "")
          liveDiff = row.patch.slice(0, 100_000);
      }
      if (events.length > MAX_SESSION_EVENTS) {
        events = events.slice(-MAX_SESSION_EVENTS);
      }
      await this.putRecord({
        ...held,
        sessionEvents: events,
        ...(liveDiff !== undefined ? { liveDiff } : {}),
      });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/approval") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const held = await this.claimedRecord(body);
      if (held instanceof Response) return held;
      if (held.envelope.personalExecution) {
        if (!this.ctx.storage.transaction) return Response.json({ error: "Permission storage unavailable." }, { status: 503 });
        const proof = held.envelope.personalExecution;
        const answer = await this.ctx.storage.transaction(async (tx) => {
          const record = await tx.get<LocalDispatchRecord>(`${RECORD_PREFIX}${held.envelope.sandboxId}`);
          const computer = await tx.get<ComputerRecord>(`${COMPUTER_PREFIX}${held.targetMachineId}`);
          if (!record || record.status !== "claimed" || record.claimToken !== body.claimToken || !computer?.personalExecution ||
            !personalComputerMatches(toConnectedComputer(computer, Date.now()), computer.personalExecution.scope, proof.snapshot) ||
            !await personalGrantFence(this.env, computer.personalExecution.scope, proof.snapshot) || proof.approvedUntil <= Date.now()) return null;
          const approvals = [...(record.harnessApprovals ?? [])];
          if (body.request && typeof body.request === "object" && !Array.isArray(body.request)) {
            const row = body.request as Record<string, unknown>;
            if (typeof row.requestId !== "string" || !row.requestId || row.requestId.length > 128 || typeof row.kind !== "string" || row.kind.length > 64 ||
              typeof row.title !== "string" || row.title.length > 200 || typeof row.detail !== "string" || row.detail.length > 2000 ||
              [row.title, row.detail].some((value) => redactSecrets(value as string) !== value) || typeof row.actionHash !== "string" || !/^[a-f0-9]{64}$/.test(row.actionHash) ||
              !await this.exactPersonalPermission(row.detail, row.actionHash, proof.snapshot.harness) ||
              !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) <= Date.now() || Number(row.expiresAt) > Math.min(proof.approvedUntil, proof.snapshot.expiresAt, record.envelope.deadlineAt, Date.now() + 600_000)) return null;
            const existing = approvals.find((item) => item.requestId === row.requestId);
            if (existing && (existing.actionHash !== row.actionHash || existing.expiresAt !== row.expiresAt || existing.detail !== row.detail || existing.title !== row.title || existing.kind !== row.kind || existing.consumedAt)) return null;
            if (!existing) {
              if (approvals.length >= 128) return null;
              approvals.push({ requestId: row.requestId, kind: row.kind, title: row.title, detail: row.detail, actionHash: row.actionHash, expiresAt: Number(row.expiresAt), createdAt: Date.now() });
              await tx.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, { ...record, harnessApprovals: approvals });
            }
            return { ok: true, actionHash: row.actionHash, expiresAt: row.expiresAt };
          }
          const permission = approvals.find((item) => item.requestId === body.requestId);
          if (!permission || !permission.actionHash || permission.actionHash !== body.actionHash || permission.expiresAt !== body.expiresAt || !permission.expiresAt || permission.expiresAt <= Date.now() || permission.consumedAt) return null;
          if (!permission.decision) return { pending: true, actionHash: permission.actionHash, expiresAt: permission.expiresAt };
          await tx.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, { ...record, harnessApprovals: approvals.map((item) => item.requestId === permission.requestId ? { ...item, consumedAt: Date.now() } : item) });
          return { decision: permission.decision, actionHash: permission.actionHash, expiresAt: permission.expiresAt };
        });
        return answer ? Response.json(answer) : Response.json({ error: "Permission changed, expired or consumed." }, { status: 409 });
      }
      const approvals = [...(held.harnessApprovals ?? [])];
      const approvalRequest = body.request;
      if (
        approvalRequest !== null &&
        typeof approvalRequest === "object" &&
        !Array.isArray(approvalRequest)
      ) {
        const row = approvalRequest as Record<string, unknown>;
        const requestId = typeof row.requestId === "string" ? row.requestId.slice(0, 128) : "";
        if (requestId === "")
          return Response.json({ error: "requestId is required." }, { status: 400 });
        if (!approvals.some((item) => item.requestId === requestId)) {
          approvals.push({
            requestId,
            kind: typeof row.kind === "string" ? row.kind.slice(0, 64) : "command",
            title: typeof row.title === "string" ? row.title.slice(0, 200) : requestId,
            detail: typeof row.detail === "string" ? row.detail.slice(0, 2000) : "",
            createdAt: now,
          });
        }
      }
      await this.putRecord({ ...held, harnessApprovals: approvals });
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      if (requestId === "") return Response.json({ ok: true });
      const found = approvals.find((item) => item.requestId === requestId);
      return Response.json(
        found?.decision !== undefined ? { decision: found.decision } : { pending: true },
      );
    }

    if (request.method === "POST" && url.pathname === "/control") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const held = await this.claimedRecord(body);
      if (held instanceof Response) return held;
      const interrupt = held.interrupt === true;
      if (interrupt) await this.putRecord({ ...held, interrupt: false });
      return Response.json({ interrupt });
    }

    if (request.method === "GET" && url.pathname === "/harness") {
      const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      const runs = [...records.values()]
        .filter((record) => record.status === "claimed")
        .filter((record) => this.harnessAllowed(record, request))
        .map((record) => ({
          sandboxId: record.envelope.sandboxId,
          events: record.sessionEvents ?? [],
          diff: record.liveDiff ?? "",
          approvals: record.harnessApprovals ?? [],
        }));
      return Response.json({ runs });
    }

    if (request.method === "POST" && url.pathname === "/harness-decide") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const rawDecision = body.decision;
      const decision: "allow" | "deny" | null =
        rawDecision === "allow" || rawDecision === "deny" ? rawDecision : null;
      if (sandboxId === "" || requestId === "" || decision === null) {
        return Response.json(
          { error: "sandboxId, requestId, and decision are required." },
          { status: 400 },
        );
      }
      const record = await this.getRecord(sandboxId);
      if (record === null || record.status !== "claimed") {
        return Response.json(
          { error: "Run is not waiting on a harness approval." },
          { status: 409 },
        );
      }
      if (!this.harnessAllowed(record, request)) {
        return Response.json({ error: "Forbidden." }, { status: 403 });
      }
      const approvals = (record.harnessApprovals ?? []).map((item) =>
        item.requestId === requestId ? { ...item, decision } : item,
      );
      if (!approvals.some((item) => item.requestId === requestId)) {
        return Response.json({ error: "Approval request not found." }, { status: 404 });
      }
      await this.putRecord({ ...record, harnessApprovals: approvals });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/harness-control") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
      const record = await this.getRecord(sandboxId);
      if (record === null || record.status !== "claimed") {
        return Response.json({ error: "Run is not claimed." }, { status: 409 });
      }
      if (!this.harnessAllowed(record, request)) {
        return Response.json({ error: "Forbidden." }, { status: 403 });
      }
      if (body.interrupt !== true)
        return Response.json({ error: "interrupt is required." }, { status: 400 });
      await this.putRecord({ ...record, interrupt: true });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/revoke-computer") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      if (typeof body.machineId !== "string" || body.machineId === "") {
        return Response.json({ error: "machineId is required." }, { status: 400 });
      }
      const existing = await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${body.machineId}`);
      if (existing?.personalExecution) return Response.json({ error: "Computer not found." }, { status: 404 });
      const outstanding = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      const hasArtifacts = [...outstanding.values()].some((record) => record.envelope.executionTarget?.kind === "artifact-workspace" &&
        record.targetMachineId === body.machineId && ["pending", "claimed"].includes(record.status));
      if (!hasArtifacts) {
        await this.ctx.storage.delete(`${COMPUTER_PREFIX}${body.machineId}`);
        return Response.json({ ok: true });
      }
      if (!this.ctx.storage.transaction) return Response.json({ error: "Computer revocation storage unavailable." }, { status: 503 });
      await this.ctx.storage.transaction(async (tx) => {
        // Dropping the record invalidates the credential and every artifact claim together.
        await tx.delete(`${COMPUTER_PREFIX}${body.machineId}`);
        const records = await tx.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
        for (const record of records.values()) {
          if (record.envelope.executionTarget?.kind === "artifact-workspace" && record.targetMachineId === body.machineId &&
            ["pending", "claimed"].includes(record.status)) {
            await tx.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, { ...record, status: "cancelled", claimToken: undefined, settledAt: now });
            await tx.put(`${ARTIFACT_DISPATCH_PREFIX}${record.envelope.sandboxId}`, true);
          }
        }
      });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  }
}

/**
 * The one claim queue per deployment. The binding is optional in Env so a
 * deployment (or test env) without the local runtime never resolves a stub
 * it cannot serve — callers check the flag first, and a missing binding is
 * a hard error, not a silent skip.
 */
export function localDispatchStub(env: {
  LocalDispatch?: DurableObjectNamespace;
}): DurableObjectStub {
  if (env.LocalDispatch === undefined) {
    throw new Error("LocalDispatch binding is not configured.");
  }
  return env.LocalDispatch.get(env.LocalDispatch.idFromName(LOCAL_DISPATCH_DO_NAME));
}
