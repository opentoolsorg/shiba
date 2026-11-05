import type { Env } from "./env.js";
import type { RunRoomIdentity } from "./run-room-events.js";
import { parseSlackCanvasOrigin, resolveSlackCanvasBinding } from "./slack-canvas.js";
import { slackAgentPersona, type SlackPersonaRole } from "./slack-persona.js";
import { SLACK_POST_TIMEOUT_MS, verifySlackBotInstallation } from "./slack.js";

const STORAGE_KEY = "slack:agent-session-outbox:v1";
const CLAIM_TIMEOUT_MS = SLACK_POST_TIMEOUT_MS * 4;
const MAX_DRAIN_PASSES = 3;
const STATUSES = ["processing", "active", "suspended", "closed"] as const;
export type SlackAgentSessionStatus = typeof STATUSES[number];
type SessionEnv = Pick<Env, "SLACK_AGENT_SESSIONS_ENABLED" | "SLACK_AGENT_SESSIONS_TEAM_ID" | "SLACK_BOT_TOKEN" | "SLACK_CANVAS_OWNERS">;

interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface SlackAgentSessionStorage {
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
}

/** Call only after verifying retained approval/run identity and signed ingress provenance. */
export interface SlackAgentSessionIntent {
  origin: string;
  approvalId: string;
  binding: RunRoomIdentity;
  /** Last committed orchestration event sequence. Older intents cannot overwrite newer ones. */
  revision: number;
  status: SlackAgentSessionStatus;
  persona?: SlackPersonaRole;
}

export interface SlackAgentSessionDelivery {
  revision: number;
  state: "pending" | "sending" | "sent" | "blocked" | "unknown";
  attempts: number;
  startedAt?: number;
  claimId?: string;
  errorCode?: string;
  agentStatus?: SlackAgentSessionStatus;
  sessionStatus?: SlackAgentSessionStatus;
  warning?: string;
}
interface SessionState {
  version: 1;
  observedRevision: number;
  desired: SlackAgentSessionIntent;
  delivery: SlackAgentSessionDelivery;
}

function validStatus(value: unknown): value is SlackAgentSessionStatus {
  return STATUSES.includes(value as SlackAgentSessionStatus);
}
function sameDesiredStatus(left: SlackAgentSessionIntent, right: SlackAgentSessionIntent): boolean {
  return left.origin === right.origin && left.approvalId === right.approvalId &&
    left.status === right.status && (left.persona ?? "lead") === (right.persona ?? "lead") &&
    left.binding.ownerId === right.binding.ownerId && left.binding.sessionId === right.binding.sessionId && left.binding.runId === right.binding.runId;
}
function safeErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,100}$/.test(value) ? value : fallback;
}

/** A single latest-value outbox; it stores no task text, tokens or approval decisions. */
export class SlackAgentSessionOutbox {
  constructor(
    private readonly storage: SlackAgentSessionStorage,
    private readonly env: SessionEnv,
    private readonly sourceStillAuthorized: (intent: SlackAgentSessionIntent) => boolean = () => true,
  ) {}

  private async authorized(intent: SlackAgentSessionIntent): Promise<boolean> {
    if (this.env.SLACK_AGENT_SESSIONS_ENABLED !== "true") return false;
    const origin = parseSlackCanvasOrigin(intent.origin);
    if (!origin || origin.orchestratorName !== intent.origin || origin.teamId !== this.env.SLACK_AGENT_SESSIONS_TEAM_ID?.trim()) return false;
    const expected = await resolveSlackCanvasBinding(this.env, intent.origin, intent.approvalId);
    return expected !== null && expected.ownerId === intent.binding.ownerId && expected.sessionId === intent.binding.sessionId && expected.runId === intent.binding.runId;
  }

  async enqueue(intent: SlackAgentSessionIntent): Promise<SlackAgentSessionDelivery | null> {
    if (this.env.SLACK_AGENT_SESSIONS_ENABLED !== "true") return null;
    intent = structuredClone(intent);
    if (!Number.isSafeInteger(intent.revision) || intent.revision < 1 || !validStatus(intent.status) ||
        (intent.persona !== undefined && !["lead", "explorer", "fixer", "reviewer"].includes(intent.persona))) {
      throw new Error("Invalid Slack agent-session intent.");
    }
    if (!await this.authorized(intent)) return { revision: intent.revision, state: "blocked", attempts: 0, errorCode: "destination_not_authorized" };
    return this.storage.transaction(async (transaction) => {
      const prior = await transaction.get<SessionState>(STORAGE_KEY);
      if (prior && prior.desired.origin !== intent.origin) throw new Error("Slack agent-session storage belongs to another thread.");
      if (prior && prior.observedRevision > intent.revision) return prior.delivery;
      if (prior && prior.observedRevision === intent.revision && !sameDesiredStatus(prior.desired, intent)) {
        throw new Error("Slack agent-session revision conflicts with its saved intent.");
      }
      if (prior && sameDesiredStatus(prior.desired, intent)) {
        await transaction.put(STORAGE_KEY, { ...prior, observedRevision: intent.revision });
        return prior.delivery;
      }
      const delivery: SlackAgentSessionDelivery = prior?.delivery.state === "sending" ? prior.delivery : { revision: intent.revision, state: "pending", attempts: 0 };
      await transaction.put<SessionState>(STORAGE_KEY, { version: 1, observedRevision: intent.revision, desired: structuredClone(intent), delivery });
      return delivery;
    });
  }

  async inspect(): Promise<SlackAgentSessionDelivery | null> {
    return this.storage.transaction(async (transaction) => (await transaction.get<SessionState>(STORAGE_KEY))?.delivery ?? null);
  }

  /** Pending writes survive restart. A claimed write with no receipt is never blindly retried. */
  async drain(now?: number): Promise<SlackAgentSessionDelivery | null> {
    if (this.env.SLACK_AGENT_SESSIONS_ENABLED !== "true") return null;
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
      const claimTime = now ?? Date.now();
      const claim = await this.storage.transaction(async (transaction) => {
        const state = await transaction.get<SessionState>(STORAGE_KEY);
        if (!state) return null;
        if (state.delivery.state === "sending") {
          if (claimTime - (state.delivery.startedAt ?? claimTime) < CLAIM_TIMEOUT_MS) return null;
          state.delivery = { ...state.delivery, state: "unknown", errorCode: "delivery_receipt_missing" };
          await transaction.put(STORAGE_KEY, state);
        }
        if (state.delivery.revision === state.desired.revision && state.delivery.state !== "pending") return null;
        const delivery: SlackAgentSessionDelivery = {
          revision: state.desired.revision, state: "sending", attempts: 1, startedAt: claimTime, claimId: crypto.randomUUID(),
        };
        await transaction.put(STORAGE_KEY, { ...state, delivery });
        return { intent: state.desired, delivery };
      });
      if (!claim) return this.inspect();
      const result = await this.deliver(claim.intent, claim.delivery);
      const newer = await this.storage.transaction(async (transaction) => {
        const state = await transaction.get<SessionState>(STORAGE_KEY);
        if (!state || state.delivery.claimId !== claim.delivery.claimId) return false;
        await transaction.put(STORAGE_KEY, { ...state, delivery: result });
        return state.desired.revision > result.revision;
      });
      if (!newer) return result;
    }
    return this.inspect();
  }

  private async deliver(intent: SlackAgentSessionIntent, delivery: SlackAgentSessionDelivery): Promise<SlackAgentSessionDelivery> {
    const blocked = (errorCode: string): SlackAgentSessionDelivery => ({ ...delivery, state: "blocked", errorCode });
    if (!await this.authorized(intent) || !this.sourceStillAuthorized(intent)) return blocked("destination_not_authorized");
    const token = this.env.SLACK_BOT_TOKEN?.trim();
    if (!token) return blocked("bot_token_missing");
    let installation: Awaited<ReturnType<typeof verifySlackBotInstallation>>;
    try { installation = await verifySlackBotInstallation(token); }
    catch { return blocked("installation_verification_failed"); }
    const origin = parseSlackCanvasOrigin(intent.origin)!;
    if (installation.teamId !== origin.teamId) return blocked("bot_workspace_mismatch");
    if (!installation.scopes) return blocked("scope_verification_unavailable");
    if (!["chat:write", "assistant:write", "chat:write.customize"].every((scope) => installation.scopes?.includes(scope))) {
      return blocked("agent_scopes_missing");
    }
    const stillCurrent = await this.storage.transaction(async (transaction) => {
      const state = await transaction.get<SessionState>(STORAGE_KEY);
      return state !== undefined && state.delivery.claimId === delivery.claimId && state.desired.revision === intent.revision;
    });
    if (!stillCurrent) return blocked("superseded_before_send");
    if (!await this.authorized(intent) || !this.sourceStillAuthorized(intent)) return blocked("destination_not_authorized");
    try {
      const response = await fetch("https://slack.com/api/agents.sessions.setStatus", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
        body: new URLSearchParams({ channel_id: origin.channelId, thread_ts: intent.origin.split(":")[3]!, status: intent.status, ...slackAgentPersona(intent.persona) }),
      });
      const body = await response.json().catch(() => null) as { ok?: unknown; error?: unknown; status?: unknown; agent_status?: unknown; warning?: unknown } | null;
      if (body?.ok === false) {
        const errorCode = safeErrorCode(body.error, "slack_rejected_status");
        return { ...delivery, state: ["fatal_error", "internal_error", "request_timeout"].includes(errorCode) || response.status >= 500 ? "unknown" : "blocked", errorCode };
      }
      if (!response.ok || body?.ok !== true || body.agent_status !== intent.status || !validStatus(body.status)) {
        return { ...delivery, state: "unknown", errorCode: "status_receipt_unconfirmed" };
      }
      return {
        ...delivery, state: "sent", agentStatus: intent.status, sessionStatus: body.status,
        ...(typeof body.warning === "string" ? { warning: safeErrorCode(body.warning, "slack_warning") } : {}),
      };
    } catch { return { ...delivery, state: "unknown", errorCode: "status_delivery_unknown" }; }
  }
}
