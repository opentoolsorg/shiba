import {
  PERSONAL_ACCOUNT_MAX_AGE_MS,
  personalAccountReceiptSchema,
  personalExecutionSnapshotSchema,
  personalPairingScopeSchema,
  type ConnectedComputer,
  type PairingTokenResponse,
  type PersonalAccountEvidence,
  type PersonalExecutionSnapshot,
} from "@shiba/shared";

export interface PersonalExecutionGrant {
  snapshot: PersonalExecutionSnapshot;
  status: "active" | "revoked";
  version: number;
}
export interface CreatePersonalGrant {
  machineId: string;
  machineRevision: number;
  harness: "claude-code" | "codex";
  accountFingerprint: string;
  authVersion: string;
  codingModel: string;
  repoUrl: string;
  expiresAt: number;
  consent: true;
  hostingConsent: true;
}
export interface PersonalHarnessApproval {
  requestId: string; kind: string; title: string; detail: string; createdAt: number;
  actionHash: string; expiresAt: number; decision?: "allow" | "deny"; consumedAt?: number; reviewIncomplete: boolean;
}
export interface PersonalHarnessRun {
  sandboxId: string; events: Array<{ seq: number; at: number; type: string; text: string }>; diff: string;
  grantVersion: number; machineRevision: number; canInterrupt: boolean; canAllow: boolean; canDeny: boolean;
  approvals: PersonalHarnessApproval[];
}
export class PersonalExecutionRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(status === 404 ? "Personal execution is unavailable for this workspace."
      : status === 401 || status === 403 ? "Use your verified native account and current workspace membership."
        : status === 409 ? "The account, machine or grant changed. Reload before continuing."
          : "Personal execution setup could not be verified. Reload before continuing.");
    this.name = "PersonalExecutionRequestError";
  }
}

/** Scope selectors are explicit. Only the server can establish ownership or consent. */
export class PersonalExecutionClient {
  constructor(readonly workspaceId: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Select a team workspace for personal execution.");
  }
  private async request(path: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const response = await this.fetcher(`/api/personal-execution${path}`, {
      method, signal, credentials: "same-origin", cache: "no-store",
      headers: { "X-Shiba-Workspace": this.workspaceId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    signal.throwIfAborted();
    const payload: unknown = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok) {
      const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" && /^[a-z0-9_]{1,100}$/.test(payload.error)
        ? payload.error : "personal_execution_request_failed";
      throw new PersonalExecutionRequestError(response.status, code);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Personal setup returned an invalid response.");
    return payload as Record<string, unknown>;
  }
  async computers(signal: AbortSignal): Promise<ConnectedComputer[]> {
    const body = await this.request("/computers", signal);
    if (!Array.isArray(body.computers)) throw new Error("Personal computers could not be verified.");
    if (body.computers.some((row: unknown) => {
      if (!row || typeof row !== "object") return true;
      const item = row as ConnectedComputer;
      return typeof item.machineId !== "string" || typeof item.hostname !== "string" || typeof item.platform !== "string" || !["idle", "busy", "offline"].includes(item.status) ||
        !Number.isFinite(item.lastHeartbeat) || !item.personalExecution || !personalPairingScopeSchema.safeParse(item.personalExecution.scope).success ||
        !Number.isSafeInteger(item.personalExecution.revision) || item.personalExecution.revision < 1 || !Array.isArray(item.personalExecution.accounts);
    })) throw new Error("Personal computers could not be verified.");
    return body.computers as ConnectedComputer[];
  }
  async grants(signal: AbortSignal): Promise<PersonalExecutionGrant[]> {
    const body = await this.request("/grants", signal);
    if (!Array.isArray(body.grants)) throw new Error("Personal grants could not be verified.");
    return body.grants.map(parseGrant);
  }
  async pair(selection: { harness: "claude-code" | "codex"; accountFingerprint: string }, signal: AbortSignal): Promise<PairingTokenResponse> {
    if (!["claude-code", "codex"].includes(selection.harness) || !/^[a-f0-9]{64}$/.test(selection.accountFingerprint)) throw new Error("Choose the native CLI and its locally inspected account fingerprint.");
    const body = await this.request("/pairing-token", signal, "POST", selection);
    if (typeof body.token !== "string" || !body.token || typeof body.connectCommand !== "string" || !body.connectCommand ||
        body.connectCommand.length > 8_000 || typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)) {
      throw new Error("The personal pairing response could not be verified.");
    }
    return { token: body.token, connectCommand: body.connectCommand, expiresAt: body.expiresAt };
  }
  async create(body: CreatePersonalGrant, signal: AbortSignal): Promise<PersonalExecutionGrant> {
    return parseGrant(await this.request("/grants", signal, "POST", body));
  }
  async revoke(grant: PersonalExecutionGrant, signal: AbortSignal): Promise<void> {
    const result = await this.request(`/grants/${encodeURIComponent(grant.snapshot.grantId)}`, signal, "DELETE", { expectedVersion: grant.version });
    if (result.revoked !== true || result.version !== grant.version + 1) throw new Error("Grant revocation could not be confirmed. Reload before continuing.");
  }
  async unpair(computer: ConnectedComputer, signal: AbortSignal): Promise<void> {
    if (!computer.personalExecution) throw new Error("This is not a personal computer.");
    const result = await this.request(`/computers/${encodeURIComponent(computer.machineId)}`, signal, "DELETE", { expectedRevision: computer.personalExecution.revision });
    if (result.revoked !== true) throw new Error("Computer revocation could not be confirmed. Reload before continuing.");
  }
  async harness(signal: AbortSignal): Promise<PersonalHarnessRun[]> {
    const body = await this.request("/harness", signal);
    if (!Array.isArray(body.runs)) throw new Error("Personal run controls could not be verified.");
    return body.runs.map((value: unknown) => {
      if (!value || typeof value !== "object") throw new Error("Personal run controls could not be verified.");
      const row = value as PersonalHarnessRun;
      if (typeof row.sandboxId !== "string" || !row.sandboxId || row.sandboxId.length > 128 || !Number.isSafeInteger(row.grantVersion) ||
          row.grantVersion < 1 || !Number.isSafeInteger(row.machineRevision) || row.machineRevision < 1 || !Array.isArray(row.approvals) || row.approvals.length > 50) {
        throw new Error("Personal run controls could not be verified.");
      }
      return { ...row, events: [], diff: "", canAllow: row.canAllow === true, canDeny: row.canDeny === true, canInterrupt: row.canInterrupt === true,
        approvals: row.approvals.map((item) => {
          if (!item || typeof item.requestId !== "string" || !item.requestId || typeof item.title !== "string" || typeof item.detail !== "string") throw new Error("Personal request details could not be verified.");
          const incomplete = item.reviewIncomplete !== false || item.title.length > 200 || item.detail.length > 2_000 ||
            !/^[a-f0-9]{64}$/.test(item.actionHash ?? "") || !Number.isSafeInteger(item.expiresAt);
          return { ...item, title: item.title.slice(0, 200), detail: item.detail.slice(0, 2_000), reviewIncomplete: incomplete };
        }) };
    });
  }
  async decide(run: PersonalHarnessRun, approval: PersonalHarnessApproval, decision: "allow" | "deny", signal: AbortSignal): Promise<void> {
    if (approval.decision || approval.consumedAt || !/^[a-f0-9]{64}$/.test(approval.actionHash) || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= Date.now() ||
        (decision === "allow" && (approval.reviewIncomplete || !run.canAllow)) || (decision === "deny" && !run.canDeny)) {
      throw new Error("This local permission request is not eligible for that decision.");
    }
    const receipt = await this.request("/harness/decide", signal, "POST", { sandboxId: run.sandboxId, requestId: approval.requestId,
      actionHash: approval.actionHash, expiresAt: approval.expiresAt, grantVersion: run.grantVersion, machineRevision: run.machineRevision, decision });
    if (receipt.ok !== true || receipt.actionHash !== approval.actionHash || receipt.expiresAt !== approval.expiresAt) throw new Error("The exact local permission receipt could not be confirmed.");
  }
  async interrupt(run: PersonalHarnessRun, signal: AbortSignal): Promise<void> {
    if (!run.canInterrupt) throw new Error("This account cannot interrupt that local process.");
    const receipt = await this.request("/harness/control", signal, "POST", { sandboxId: run.sandboxId, grantVersion: run.grantVersion, machineRevision: run.machineRevision, interrupt: true });
    if (receipt.ok !== true) throw new Error("The local interruption receipt could not be confirmed.");
  }
}

function parseGrant(value: unknown): PersonalExecutionGrant {
  if (!value || typeof value !== "object") throw new Error("The personal grant could not be verified.");
  const row = value as Record<string, unknown>;
  const snapshot = personalExecutionSnapshotSchema.safeParse(row.snapshot);
  if (!snapshot.success || !["active", "revoked"].includes(String(row.status)) || !Number.isSafeInteger(row.version) || Number(row.version) < 1) {
    throw new Error("The personal grant could not be verified.");
  }
  return { snapshot: snapshot.data, status: row.status as PersonalExecutionGrant["status"], version: Number(row.version) };
}

export function currentPersonalAccounts(computer: ConnectedComputer, workspaceId: string, actorId: string, now: number): PersonalAccountEvidence[] {
  const binding = computer.personalExecution;
  if (!binding || binding.scope?.workspaceId !== workspaceId || binding.scope.actorId !== actorId ||
      computer.status !== "idle" || !Number.isFinite(computer.lastHeartbeat) || now - computer.lastHeartbeat > PERSONAL_ACCOUNT_MAX_AGE_MS ||
      computer.lastHeartbeat > now + 5_000 || !Array.isArray(binding.accounts)) return [];
  return binding.accounts.filter((account) => account !== null && typeof account === "object" && personalAccountReceiptSchema.safeParse({
    schemaVersion: account.schemaVersion, harness: account.harness, billingMode: account.billingMode,
    accountFingerprint: account.accountFingerprint, authVersion: account.authVersion, cliVersion: account.cliVersion,
    probeMethod: account.probeMethod, probedAt: account.probedAt,
  }).success && supportedLocalReceipt(computer, account) && Number.isFinite(account.receivedAt) && now - account.receivedAt <= PERSONAL_ACCOUNT_MAX_AGE_MS &&
    account.receivedAt <= now + 5_000 && now - account.probedAt <= PERSONAL_ACCOUNT_MAX_AGE_MS && account.probedAt <= now + 5_000);
}

function supportedLocalReceipt(computer: ConnectedComputer, account: PersonalAccountEvidence): boolean {
  const version = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(account.cliVersion);
  if (!version) return false;
  const actual = [Number(version[1]), Number(version[2]), Number(version[3])];
  const minimum = account.harness === "claude-code" ? [2, 1, 268] : [0, 157, 1];
  const supportedPlatform = account.harness === "claude-code" ? computer.platform.startsWith("linux-") : /^(?:linux|darwin)-/.test(computer.platform);
  const comparison = actual.findIndex((part, index) => part !== minimum[index]);
  return supportedPlatform && (comparison < 0 || actual[comparison]! > minimum[comparison]!);
}

export function personalGrantAvailable(grant: PersonalExecutionGrant, computers: readonly ConnectedComputer[], workspaceId: string, actorId: string, now: number): boolean {
  const snapshot = grant.snapshot;
  const computer = computers.find((item) => item.machineId === snapshot.machineId);
  return grant.status === "active" && grant.version === snapshot.grantVersion && snapshot.expiresAt > now &&
    snapshot.workspaceId === workspaceId && snapshot.actorId === actorId && computer?.personalExecution?.revision === snapshot.machineRevision &&
    computer.personalExecution.scope.ownerAccountId === snapshot.ownerAccountId && computer.personalExecution.scope.membershipVersion === snapshot.membershipVersion &&
    currentPersonalAccounts(computer, workspaceId, actorId, now).some((account) => account.harness === snapshot.harness &&
      account.billingMode === snapshot.billingMode && account.accountFingerprint === snapshot.accountFingerprint && account.authVersion === snapshot.authVersion);
}
