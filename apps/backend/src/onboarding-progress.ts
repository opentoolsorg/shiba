import { getAgentByName } from "agents/routing";
import type { AcpProviderCard } from "@shiba/shared";
import type { Env } from "./env.js";
import { readProviderSnapshot } from "./acp-providers.js";
import { betterAuthFor, ensureBetterAuthSchema, isBetterAuthConfigured } from "./better-auth.js";
import {
  buildSessionAgentName,
  isAuthorizedSessionAgent,
  validateSessionRecordIntegrity,
  type WebSessionRecord,
} from "./web-sessions.js";

export const ONBOARDING_PROGRESS_PATH = "/api/onboarding/progress";
export const ONBOARDING_STEPS = ["channels", "agent", "models", "employee"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingIdentity {
  /** Better Auth's immutable account id; this is never accepted from the client. */
  userId: string;
  /** Existing provider and run stores remain keyed by email. */
  ownerEmail: string;
}

export interface OnboardingProgress {
  currentStep: OnboardingStep;
  dismissedAt: number | null;
  connectionVerifiedAt: number | null;
  firstSuccessfulRunAt: number | null;
  acceptedArtifactAt: number | null;
  activatedAt: number | null;
  revision: number;
  evidence: { connectedProvider: boolean | null; successfulRun: boolean | null; acceptedDeliverable: boolean | null };
}

interface StoredProgress {
  current_step: string;
  dismissed_at: number | null;
  connection_verified_at: number | null;
  first_successful_run_at: number | null;
  accepted_artifact_at: number | null;
  activated_at: number | null;
  revision: number;
}

interface RunAgentStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface OnboardingProgressDeps {
  resolveIdentity?: (request: Request, env: Env) => Promise<OnboardingIdentity | null>;
  readProviders?: (env: Env, ownerEmail: string) => Promise<readonly AcpProviderCard[]>;
  readSuccessfulRun?: (env: Env, ownerEmail: string) => Promise<boolean | null>;
  readAcceptedDeliverable?: (env: Env, ownerEmail: string) => Promise<boolean | null>;
  getRunAgent?: (env: Env, name: string) => Promise<RunAgentStub>;
  now?: () => number;
}

const initialized = new WeakSet<D1Database>();

async function ensureSchema(db: D1Database): Promise<void> {
  if (initialized.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_onboarding_progress (
    user_id TEXT PRIMARY KEY,
    current_step TEXT NOT NULL DEFAULT 'channels' CHECK (current_step IN ('channels','agent','models','employee')),
    dismissed_at INTEGER,
    connection_verified_at INTEGER,
    first_successful_run_at INTEGER,
    accepted_artifact_at INTEGER,
    activated_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  // Existing self-hosted installs created this table before artifact acceptance existed.
  let addedAcceptedArtifactColumn = false;
  try {
    await db.prepare(`ALTER TABLE user_onboarding_progress ADD COLUMN accepted_artifact_at INTEGER`).run();
    addedAcceptedArtifactColumn = true;
  } catch (error) {
    if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  if (addedAcceptedArtifactColumn) {
    // Earlier activation was based on any completed run. Keep it from being
    // mistaken for the stronger accepted-deliverable signal after upgrade.
    await db.prepare(`UPDATE user_onboarding_progress SET activated_at=NULL,revision=revision+1,
      updated_at=MAX(updated_at,CAST(strftime('%s','now') AS INTEGER)*1000)
      WHERE accepted_artifact_at IS NULL AND activated_at IS NOT NULL`).run();
  }
  initialized.add(db);
}

async function readStored(db: D1Database, userId: string): Promise<StoredProgress | null> {
  return db.prepare(`SELECT current_step,dismissed_at,connection_verified_at,first_successful_run_at,accepted_artifact_at,activated_at,revision
    FROM user_onboarding_progress WHERE user_id=?`).bind(userId).first<StoredProgress>();
}

function isStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

function toProgress(row: StoredProgress, evidence: OnboardingProgress["evidence"] = { connectedProvider: null, successfulRun: null, acceptedDeliverable: null }): OnboardingProgress {
  return {
    currentStep: isStep(row.current_step) ? row.current_step : "channels",
    dismissedAt: row.dismissed_at,
    connectionVerifiedAt: row.connection_verified_at,
    firstSuccessfulRunAt: row.first_successful_run_at,
    acceptedArtifactAt: row.accepted_artifact_at,
    activatedAt: row.activated_at,
    revision: row.revision,
    evidence,
  };
}

async function resolveIdentity(request: Request, env: Env): Promise<OnboardingIdentity | null> {
  if (!isBetterAuthConfigured(env) || !env.AGENT_AUDIT) return null;
  try {
    await ensureBetterAuthSchema(env);
    const session = await betterAuthFor(env).api.getSession({ headers: request.headers });
    const userId = session?.user?.id;
    const ownerEmail = session?.user?.email;
    if (typeof userId !== "string" || !userId.trim() || typeof ownerEmail !== "string" || !ownerEmail.trim()) return null;
    return { userId: userId.trim(), ownerEmail: ownerEmail.trim() };
  } catch {
    return null;
  }
}

async function readProviders(env: Env, ownerEmail: string): Promise<readonly AcpProviderCard[]> {
  return (await readProviderSnapshot(env, ownerEmail)).providers;
}

export async function readSuccessfulRunEvidence(
  env: Env,
  ownerEmail: string,
  getAgent: (env: Env, name: string) => Promise<RunAgentStub> = (target, name) => getAgentByName(target.CodingOrchestrator, name),
): Promise<boolean | null> {
  try {
    const base = await getAgent(env, ownerEmail);
    const response = await base.fetch("https://internal/internal/web-sessions");
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) return null;
    const names = new Set<string>([ownerEmail]);
    for (const candidate of (body as { sessions: unknown[] }).sessions) {
      if (validateSessionRecordIntegrity(candidate, ownerEmail) !== null) continue;
      const session = candidate as WebSessionRecord;
      if (session.id === "default") continue;
      const name = buildSessionAgentName(ownerEmail, session.id);
      if (isAuthorizedSessionAgent(name, ownerEmail)) names.add(name);
    }
    const results = await Promise.allSettled([...names].map(async (name) => {
      const stub = name === ownerEmail ? base : await getAgent(env, name);
      const runsResponse = await stub.fetch("https://internal/api/runs");
      if (!runsResponse.ok) throw new Error("Run evidence unavailable.");
      const runsBody: unknown = await runsResponse.json();
      if (typeof runsBody !== "object" || runsBody === null || !Array.isArray((runsBody as { runs?: unknown }).runs)) throw new Error("Invalid run evidence.");
      return (runsBody as { runs: unknown[] }).runs.some((run) => typeof run === "object" && run !== null && (run as { status?: unknown }).status === "completed");
    }));
    if (results.some((result) => result.status === "fulfilled" && result.value)) return true;
    return results.every((result) => result.status === "fulfilled") ? false : null;
  } catch {
    return null;
  }
}

/** Require an owner-reviewed completed artifact before recording onboarding acceptance. */
export async function readAcceptedDeliverableEvidence(
  env: Env,
  ownerEmail: string,
  getAgent: (env: Env, name: string) => Promise<RunAgentStub> = (target, name) => getAgentByName(target.CodingOrchestrator, name),
): Promise<boolean | null> {
  try {
    const base = await getAgent(env, ownerEmail);
    const response = await base.fetch("https://internal/internal/web-sessions");
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) return null;
    const names = new Set<string>([ownerEmail]);
    for (const candidate of (body as { sessions: unknown[] }).sessions) {
      if (validateSessionRecordIntegrity(candidate, ownerEmail) !== null) continue;
      const session = candidate as WebSessionRecord;
      if (session.id === "default") continue;
      const name = buildSessionAgentName(ownerEmail, session.id);
      if (isAuthorizedSessionAgent(name, ownerEmail)) names.add(name);
    }
    const results = await Promise.allSettled([...names].map(async (name) => {
      const stub = name === ownerEmail ? base : await getAgent(env, name);
      const runsResponse = await stub.fetch("https://internal/api/runs");
      if (!runsResponse.ok) throw new Error("Run evidence unavailable.");
      const runsBody: unknown = await runsResponse.json();
      if (typeof runsBody !== "object" || runsBody === null || !Array.isArray((runsBody as { runs?: unknown }).runs)) throw new Error("Invalid run evidence.");
      return (runsBody as { runs: unknown[] }).runs.some((run) => {
        if (typeof run !== "object" || run === null || (run as { status?: unknown }).status !== "completed") return false;
        const deliverables = (run as { deliverables?: unknown }).deliverables;
        return Array.isArray(deliverables) && deliverables.some((item) => {
          if (typeof item !== "object" || item === null) return false;
          const artifact = item as { artifactId?: unknown; version?: unknown; path?: unknown; sha256?: unknown; review?: { status?: unknown } };
          return typeof artifact.artifactId === "string" && artifact.artifactId.length > 0 &&
            Number.isSafeInteger(artifact.version) && Number(artifact.version) > 0 &&
            typeof artifact.path === "string" && artifact.path.length > 0 &&
            typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
            artifact.review?.status === "approved";
        });
      });
    }));
    if (results.some((result) => result.status === "fulfilled" && result.value)) return true;
    return results.every((result) => result.status === "fulfilled") ? false : null;
  } catch {
    return null;
  }
}

async function readEvidence(env: Env, identity: OnboardingIdentity, deps: OnboardingProgressDeps) {
  const [providers, successfulRun, acceptedDeliverable] = await Promise.all([
    (deps.readProviders ?? readProviders)(env, identity.ownerEmail).catch(() => null),
    (deps.readSuccessfulRun ?? ((target, email) => readSuccessfulRunEvidence(target, email, deps.getRunAgent)))(env, identity.ownerEmail).catch(() => null),
    (deps.readAcceptedDeliverable ?? ((target, email) => readAcceptedDeliverableEvidence(target, email, deps.getRunAgent)))(env, identity.ownerEmail).catch(() => null),
  ]);
  return {
    connectedProvider: providers === null ? null : providers.some((provider) => provider.connection.phase === "connected"),
    successfulRun,
    acceptedDeliverable,
  };
}

async function updateAction(db: D1Database, userId: string, expectedRevision: number, action: "step" | "dismiss" | "resume", currentStep: OnboardingStep | undefined, now: number): Promise<boolean> {
  const current = await readStored(db, userId);
  if (!current || current.revision !== expectedRevision) return false;
  const step = action === "step" && currentStep ? currentStep : (isStep(current.current_step) ? current.current_step : "channels");
  const dismissedAt = action === "dismiss" ? now : null;
  const result = await db.prepare(`UPDATE user_onboarding_progress SET current_step=?,dismissed_at=?,revision=revision+1,updated_at=?
    WHERE user_id=? AND revision=?`).bind(step, dismissedAt, now, userId, expectedRevision).run();
  if (typeof result.meta?.changes === "number") return result.meta.changes === 1;
  return (await readStored(db, userId))?.revision === expectedRevision + 1;
}

async function persistEvidence(db: D1Database, userId: string, evidence: OnboardingProgress["evidence"], now: number): Promise<void> {
  const connectedAt = evidence.connectedProvider === true ? now : null;
  const runAt = evidence.successfulRun === true ? now : null;
  const acceptedAt = evidence.acceptedDeliverable === true ? now : null;
  await db.prepare(`UPDATE user_onboarding_progress SET
    connection_verified_at=COALESCE(connection_verified_at,?),
    first_successful_run_at=COALESCE(first_successful_run_at,?),
    accepted_artifact_at=COALESCE(accepted_artifact_at,?),
    activated_at=CASE WHEN activated_at IS NOT NULL THEN activated_at
      WHEN (connection_verified_at IS NOT NULL OR ? IS NOT NULL) AND (accepted_artifact_at IS NOT NULL OR ? IS NOT NULL) THEN ? ELSE NULL END,
    revision=revision+CASE WHEN (connection_verified_at IS NULL AND ? IS NOT NULL)
      OR (first_successful_run_at IS NULL AND ? IS NOT NULL)
      OR (accepted_artifact_at IS NULL AND ? IS NOT NULL)
      OR (activated_at IS NULL AND (connection_verified_at IS NOT NULL OR ? IS NOT NULL)
        AND (accepted_artifact_at IS NOT NULL OR ? IS NOT NULL)) THEN 1 ELSE 0 END,
    updated_at=MAX(updated_at,?) WHERE user_id=?`).bind(
    connectedAt, runAt, acceptedAt, connectedAt, acceptedAt, now, connectedAt, runAt, acceptedAt, connectedAt, acceptedAt, now, userId,
  ).run();
}

async function parseAction(request: Request): Promise<{ action: "step" | "dismiss" | "resume"; expectedRevision: number; currentStep?: OnboardingStep } | null> {
  let value: unknown;
  try { value = await request.json(); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["action", "currentStep", "expectedRevision"].includes(key))) return null;
  if (body.action !== "step" && body.action !== "dismiss" && body.action !== "resume") return null;
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) return null;
  if (body.currentStep !== undefined && !isStep(body.currentStep)) return null;
  if (body.action === "step" && !isStep(body.currentStep)) return null;
  return { action: body.action, expectedRevision: Number(body.expectedRevision), ...(isStep(body.currentStep) ? { currentStep: body.currentStep } : {}) };
}

function progressResponse(progress: OnboardingProgress, status = 200): Response {
  return Response.json(progress, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleOnboardingProgress(request: Request, env: Env, deps: OnboardingProgressDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ONBOARDING_PROGRESS_PATH) return null;
  if (request.method !== "GET" && request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405, headers: { "Cache-Control": "no-store" } });
  if (request.method === "POST" && (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site")) return Response.json({ error: "Same-origin request required." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (!isBetterAuthConfigured(env)) return Response.json({ error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const identity = await (deps.resolveIdentity ?? resolveIdentity)(request, env);
  if (!identity?.userId.trim() || !identity.ownerEmail.trim()) return Response.json({ error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const action = request.method === "POST" ? await parseAction(request) : null;
  if (request.method === "POST" && !action) return Response.json({ error: "Invalid onboarding progress update." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    if (!env.AGENT_AUDIT) throw new Error("Progress storage unavailable.");
    const db = env.AGENT_AUDIT;
    const now = (deps.now ?? Date.now)();
    await ensureSchema(db);
    await db.prepare(`INSERT INTO user_onboarding_progress (user_id,current_step,revision,created_at,updated_at)
      VALUES (?,'channels',0,?,?) ON CONFLICT(user_id) DO NOTHING`).bind(identity.userId, now, now).run();
    if (action && !(await updateAction(db, identity.userId, action.expectedRevision, action.action, action.currentStep, now))) {
      const current = await readStored(db, identity.userId);
      if (!current) throw new Error("Progress row unavailable.");
      return progressResponse(toProgress(current), 409);
    }
    // Save user action first; provider/run outages are represented as unknown evidence.
    const evidence = await readEvidence(env, identity, deps);
    try { await persistEvidence(db, identity.userId, evidence, now); }
    catch {
      const saved = await readStored(db, identity.userId);
      if (!saved) throw new Error("Progress row unavailable.");
      return progressResponse(toProgress(saved));
    }
    const current = await readStored(db, identity.userId);
    if (!current) throw new Error("Progress row unavailable.");
    return progressResponse(toProgress(current, evidence));
  } catch {
    return Response.json({ error: "Onboarding progress is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
