import { getAgentByName } from "agents/routing";
import { onboardingTaskText, type AcpProviderCard } from "@shiba/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import { readProviderSnapshot } from "./acp-providers.js";
import { betterAuthFor, ensureBetterAuthSchema, isBetterAuthConfigured } from "./better-auth.js";
import { getCustomAgentById, getCustomAgentVersion } from "./custom-agents-store.js";
import { DASHBOARD_ORG_ID } from "./org-request-auth.js";
import { ownerMemoryStub } from "./memory-do.js";
import {
  buildSessionAgentName,
  isAuthorizedSessionAgent,
  validateSessionRecordIntegrity,
  type WebSessionRecord,
} from "./web-sessions.js";

export const ONBOARDING_PROGRESS_PATH = "/api/onboarding/progress";
export const ONBOARDING_STEPS = ["channels", "agent", "models", "employee"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const OUTCOME_STEPS = ["goal", "audience", "acceptance", "role", "help", "employee", "context", "connections", "review"] as const;
const answer = z.string().trim().max(4000);
const nullableId = z.string().trim().min(1).max(128).nullable();
const stepList = z.array(z.enum(OUTCOME_STEPS)).max(OUTCOME_STEPS.length).refine((items) => new Set(items).size === items.length);
const draftFields = z.object({
  currentStep: z.enum(OUTCOME_STEPS),
  goal: answer, audience: answer, acceptance: answer, roleAnswer: answer, helpAnswer: answer,
  contextAnswer: answer, employeeAnswer: answer, connectionAnswer: answer,
  employeeId: nullableId,
  employeeVersion: z.number().int().positive().safe().nullable(),
  employeeTemplateId: z.enum(["engineering", "marketing", "research", "operations", "sales", "product", "design"]).nullable(),
  employeeTemplateVersion: z.literal(1).nullable(),
  sourceIds: z.array(z.string().trim().min(1).max(128)).max(25).refine((items) => new Set(items).size === items.length),
  completedSteps: stepList, skippedSteps: stepList,
}).strict();
const sourceRefSchema = z.object({ id: z.string().min(1).max(128), version: z.number().int().positive().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type OnboardingSourceRef = z.infer<typeof sourceRefSchema>;
export type DraftTask = z.infer<typeof draftFields> & { schemaVersion: 2; version: number; preparedAt: number | null; sourceRefs: OnboardingSourceRef[] };
export interface PreparedOnboardingDraft { draftTaskId: string; version: number; draftTask: DraftTask }
type DraftPatch = Partial<z.infer<typeof draftFields>>;
type ProgressAction = { action: "step" | "dismiss" | "resume" | "save-draft" | "prepare-task"; expectedRevision: number; currentStep?: OnboardingStep; draftTask?: DraftPatch };

function emptyDraft(): DraftTask {
  return { schemaVersion: 2, version: 1, currentStep: "goal", goal: "", audience: "", acceptance: "", roleAnswer: "", helpAnswer: "",
    contextAnswer: "", employeeAnswer: "", connectionAnswer: "",
    employeeId: null, employeeVersion: null, employeeTemplateId: null, employeeTemplateVersion: null,
    sourceIds: [], completedSteps: [], skippedSteps: [], preparedAt: null, sourceRefs: [] };
}

export interface OnboardingIdentity {
  /** Better Auth's immutable account id; this is never accepted from the client. */
  userId: string;
  /** Existing provider and run stores remain keyed by email. */
  ownerEmail: string;
}

export interface OnboardingProgress {
  schemaVersion: 2;
  draftTaskId: string | null;
  draftTask: DraftTask | null;
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
  draft_task_id: string | null;
  draft_task_json: string | null;
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
  readAcceptedDeliverable?: (env: Env, ownerEmail: string, draftTaskId: string, draftTaskVersion: number) => Promise<boolean | null>;
  getRunAgent?: (env: Env, name: string) => Promise<RunAgentStub>;
  readSourceRefs?: typeof readOnboardingSourceRefs;
  now?: () => number;
}

const initialized = new WeakSet<D1Database>();

async function ensureSchema(db: D1Database): Promise<void> {
  if (initialized.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_onboarding_progress (
    user_id TEXT PRIMARY KEY,
    draft_task_id TEXT,
    draft_task_json TEXT,
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
  for (const column of ["draft_task_id", "draft_task_json"]) {
    try {
      await db.prepare(`ALTER TABLE user_onboarding_progress ADD COLUMN ${column} TEXT`).run();
    } catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  // Legacy acceptance had no goal binding. This is retryable after partial schema upgrades.
  await db.prepare(`UPDATE user_onboarding_progress SET accepted_artifact_at=NULL,activated_at=NULL,revision=revision+1
    WHERE draft_task_id IS NULL AND (accepted_artifact_at IS NOT NULL OR activated_at IS NOT NULL)`).run();
  initialized.add(db);
}

async function readStored(db: D1Database, userId: string): Promise<StoredProgress | null> {
  return db.prepare(`SELECT draft_task_id,draft_task_json,current_step,dismissed_at,connection_verified_at,first_successful_run_at,accepted_artifact_at,activated_at,revision
    FROM user_onboarding_progress WHERE user_id=?`).bind(userId).first<StoredProgress>();
}

function isStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

function toProgress(row: StoredProgress, evidence: OnboardingProgress["evidence"] = { connectedProvider: null, successfulRun: null, acceptedDeliverable: null }): OnboardingProgress {
  return {
    schemaVersion: 2,
    draftTaskId: row.draft_task_id,
    draftTask: row.draft_task_json ? JSON.parse(row.draft_task_json) as DraftTask : null,
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
  draftTaskId?: string,
  draftTaskVersion?: number,
): Promise<boolean | null> {
  if (!draftTaskId || !Number.isSafeInteger(draftTaskVersion) || Number(draftTaskVersion) < 1) return false;
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
      const approvedArtifact = (item: unknown) => {
        if (typeof item !== "object" || item === null) return false;
        const artifact = item as { artifactId?: unknown; version?: unknown; path?: unknown; sha256?: unknown; review?: { status?: unknown } };
        return typeof artifact.artifactId === "string" && artifact.artifactId.length > 0 &&
          Number.isSafeInteger(artifact.version) && Number(artifact.version) > 0 &&
          typeof artifact.path === "string" && artifact.path.length > 0 &&
          typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256) && artifact.review?.status === "approved";
      };
      const acceptedRun = (runsBody as { runs: unknown[] }).runs.some((run) => {
        if (typeof run !== "object" || run === null) return false;
        const binding = run as { status?: unknown; draftTaskId?: unknown; draftTaskVersion?: unknown };
        if (binding.status !== "completed" || binding.draftTaskId !== draftTaskId || binding.draftTaskVersion !== draftTaskVersion) return false;
        const deliverables = (run as { deliverables?: unknown }).deliverables;
        return Array.isArray(deliverables) && deliverables.some(approvedArtifact);
      });
      if (acceptedRun) return true;
      const draftResponse = await stub.fetch("https://internal/api/employee-drafts");
      if (!draftResponse.ok) throw new Error("Draft evidence unavailable.");
      const draftBody = await draftResponse.json() as { drafts?: unknown };
      if (!Array.isArray(draftBody.drafts)) throw new Error("Invalid draft evidence.");
      return draftBody.drafts.some((value) => {
        if (!value || typeof value !== "object") return false;
        const draft = value as { orgId?: unknown; actorId?: unknown; executionContextId?: unknown; draftTaskId?: unknown; draftTaskVersion?: unknown; source?: { draftTaskId?: unknown; draftTaskVersion?: unknown }; deliverable?: unknown };
        return draft.orgId === DASHBOARD_ORG_ID && draft.actorId === ownerEmail && draft.executionContextId === name &&
          draft.draftTaskId === draftTaskId && draft.draftTaskVersion === draftTaskVersion &&
          draft.source?.draftTaskId === draftTaskId && draft.source?.draftTaskVersion === draftTaskVersion && approvedArtifact(draft.deliverable);
      });
    }));
    if (results.some((result) => result.status === "fulfilled" && result.value)) return true;
    return results.every((result) => result.status === "fulfilled") ? false : null;
  } catch {
    return null;
  }
}

async function readEvidence(env: Env, identity: OnboardingIdentity, deps: OnboardingProgressDeps, progress: OnboardingProgress) {
  const [providers, successfulRun, acceptedDeliverable] = await Promise.all([
    (deps.readProviders ?? readProviders)(env, identity.ownerEmail).catch(() => null),
    (deps.readSuccessfulRun ?? ((target, email) => readSuccessfulRunEvidence(target, email, deps.getRunAgent)))(env, identity.ownerEmail).catch(() => null),
    progress.draftTaskId && progress.draftTask?.preparedAt !== null && progress.draftTask
      ? (deps.readAcceptedDeliverable ?? ((target, email, id, version) => readAcceptedDeliverableEvidence(target, email, deps.getRunAgent, id, version)))(env, identity.ownerEmail, progress.draftTaskId, progress.draftTask.version).catch(() => null)
      : Promise.resolve(false),
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
  const step = action !== "resume" && currentStep ? currentStep : (isStep(current.current_step) ? current.current_step : "channels");
  const dismissedAt = action === "dismiss" ? now : null;
  const result = await db.prepare(`UPDATE user_onboarding_progress SET current_step=?,dismissed_at=?,revision=revision+1,updated_at=?
    WHERE user_id=? AND revision=?`).bind(step, dismissedAt, now, userId, expectedRevision).run();
  if (typeof result.meta?.changes === "number") return result.meta.changes === 1;
  return (await readStored(db, userId))?.revision === expectedRevision + 1;
}

export async function readOnboardingSourceRefs(env: Env, ownerEmail: string, sourceIds: string[], expectedRefs?: OnboardingSourceRef[]): Promise<OnboardingSourceRef[] | null> {
  if (sourceIds.length === 0) return expectedRefs?.length ? null : [];
  try {
    const stub = await ownerMemoryStub(env, ownerEmail);
    const response = await stub.fetch("https://internal/internal/memory/sources/snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceIds, ...(expectedRefs ? { expectedRefs } : {}) }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { snapshot?: { sources?: unknown } };
    const result = z.array(sourceRefSchema).max(25).safeParse(body.snapshot?.sources);
    if (!result.success || result.data.length !== sourceIds.length) return null;
    const byId = new Map(result.data.map((ref) => [ref.id, ref]));
    const ordered = sourceIds.map((id) => byId.get(id));
    if (byId.size !== sourceIds.length || ordered.some((ref) => !ref)) return null;
    const refs = ordered as OnboardingSourceRef[];
    return expectedRefs && JSON.stringify(expectedRefs) !== JSON.stringify(refs) ? null : refs;
  } catch { return null; }
}

/** Trusted server actor only. Email must still map to exactly one current auth user. */
export async function resolvePreparedOnboardingDraft(env: Env, trustedOwnerEmail: string, reference: { draftTaskId: string; version: number }): Promise<PreparedOnboardingDraft | null> {
  if (!env.AGENT_AUDIT || !isBetterAuthConfigured(env) ||
    !/^draft_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference.draftTaskId) ||
    !Number.isSafeInteger(reference.version) || reference.version < 1) return null;
  try {
    await ensureBetterAuthSchema(env);
    await ensureSchema(env.AGENT_AUDIT);
    const users = await env.AGENT_AUDIT.prepare(`SELECT id FROM "user" WHERE lower(trim(email))=? LIMIT 2`).bind(trustedOwnerEmail.trim().toLowerCase()).all<{ id: string }>();
    if (users.results.length !== 1 || !users.results[0]?.id) return null;
    const row = await readStored(env.AGENT_AUDIT, users.results[0].id);
    if (!row || row.draft_task_id !== reference.draftTaskId || !row.draft_task_json) return null;
    const draftTask = JSON.parse(row.draft_task_json) as DraftTask;
    if (draftTask.schemaVersion !== 2 || draftTask.version !== reference.version || draftTask.preparedAt === null || !draftTask.goal || !draftTask.audience || !draftTask.acceptance || !draftTask.employeeId || !draftTask.employeeVersion || onboardingTaskText(draftTask).length > 4000) return null;
    const employee = await getCustomAgentById(env as Env & { AGENT_AUDIT: D1Database }, DASHBOARD_ORG_ID, draftTask.employeeId);
    if (!employee || employee.version !== draftTask.employeeVersion ||
      !await readOnboardingSourceRefs(env, trustedOwnerEmail, draftTask.sourceIds, draftTask.sourceRefs)) return null;
    const latest = await readStored(env.AGENT_AUDIT, users.results[0].id);
    if (latest?.revision !== row.revision || latest.draft_task_json !== row.draft_task_json) return null;
    return { draftTaskId: row.draft_task_id, version: draftTask.version, draftTask };
  } catch { return null; }
}

async function updateDraft(env: Env, identity: OnboardingIdentity, action: ProgressAction, now: number, deps: OnboardingProgressDeps): Promise<"saved" | "conflict" | "invalid"> {
  const db = env.AGENT_AUDIT;
  if (!db) throw new Error("Progress storage unavailable.");
  const userId = identity.userId;
  const row = await readStored(db, userId);
  if (!row || row.revision !== action.expectedRevision) return "conflict";
  const previous = row.draft_task_json ? JSON.parse(row.draft_task_json) as DraftTask : null;
  const draft = { ...(previous ?? emptyDraft()), ...action.draftTask };
  const validPair = (id: unknown, version: unknown) => (id === null) === (version === null);
  if (!validPair(draft.employeeId, draft.employeeVersion) || !validPair(draft.employeeTemplateId, draft.employeeTemplateVersion) ||
    draft.completedSteps.some((step) => draft.skippedSteps.includes(step))) return "invalid";
  // These are saved conversation answers, never provider/source readiness claims.
  for (const step of draft.completedSteps) {
    if (step === "connections" ||
      (step === "goal" && !draft.goal) || (step === "audience" && !draft.audience) ||
      (step === "acceptance" && !draft.acceptance) || (step === "role" && !draft.roleAnswer) ||
      (step === "help" && !draft.helpAnswer) || (step === "employee" && !draft.employeeId && !draft.employeeTemplateId)) return "invalid";
  }
  if (draft.employeeId && (draft.employeeVersion === null || !await getCustomAgentVersion({ AGENT_AUDIT: db }, DASHBOARD_ORG_ID, draft.employeeId, draft.employeeVersion))) return "invalid";
  const contentKeys = ["goal", "audience", "acceptance", "roleAnswer", "helpAnswer", "contextAnswer", "employeeAnswer", "connectionAnswer", "employeeId", "employeeVersion", "employeeTemplateId", "employeeTemplateVersion", "sourceIds"] as const;
  let changed = previous !== null && contentKeys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(draft[key]));
  if (changed) {
    draft.version += 1;
    draft.preparedAt = null;
    draft.sourceRefs = [];
    draft.completedSteps = draft.completedSteps.filter((step) => step !== "review");
  }
  if (action.action === "prepare-task") {
    if (!draft.goal || !draft.audience || !draft.acceptance || onboardingTaskText(draft).length > 4000) return "invalid";
    const refs = await (deps.readSourceRefs ?? readOnboardingSourceRefs)(env, identity.ownerEmail, draft.sourceIds);
    if (!refs) return "invalid";
    if (!changed && previous?.preparedAt !== null && previous && JSON.stringify(previous.sourceRefs) !== JSON.stringify(refs)) {
      changed = true;
      draft.version += 1;
      draft.preparedAt = null;
    }
    draft.sourceRefs = refs;
    draft.preparedAt ??= now;
    draft.currentStep = "review";
    draft.skippedSteps = draft.skippedSteps.filter((step) => step !== "review");
    if (!draft.completedSteps.includes("review")) draft.completedSteps.push("review");
  } else if (draft.completedSteps.includes("review") && draft.preparedAt === null) return "invalid";
  const json = JSON.stringify(draft);
  if (previous && json === row.draft_task_json) {
    const latest = await readStored(db, userId);
    return latest?.revision === row.revision && latest.draft_task_json === json ? "saved" : "conflict";
  }
  const result = await db.prepare(`UPDATE user_onboarding_progress SET draft_task_id=?,draft_task_json=?,
    accepted_artifact_at=CASE WHEN ? THEN NULL ELSE accepted_artifact_at END,
    activated_at=CASE WHEN ? THEN NULL ELSE activated_at END,
    dismissed_at=NULL,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?`).bind(
    row.draft_task_id ?? `draft_${crypto.randomUUID()}`, json, changed ? 1 : 0, changed ? 1 : 0, now, userId, action.expectedRevision,
  ).run();
  return result.meta?.changes === 1 ? "saved" : "conflict";
}

async function persistEvidence(db: D1Database, userId: string, evidence: OnboardingProgress["evidence"], now: number, expectedRevision: number): Promise<void> {
  const connectedAt = evidence.connectedProvider === true ? now : null;
  const runAt = evidence.successfulRun === true ? now : null;
  const acceptedAt = evidence.acceptedDeliverable === true ? now : null;
  await db.prepare(`UPDATE user_onboarding_progress SET
    connection_verified_at=COALESCE(connection_verified_at,?),
    first_successful_run_at=COALESCE(first_successful_run_at,?),
    accepted_artifact_at=COALESCE(accepted_artifact_at,?),
    -- Activation records a useful accepted outcome, not connection readiness.
    activated_at=CASE WHEN activated_at IS NOT NULL THEN activated_at
      WHEN (accepted_artifact_at IS NOT NULL OR ? IS NOT NULL) THEN ? ELSE NULL END,
    revision=revision+CASE WHEN (connection_verified_at IS NULL AND ? IS NOT NULL)
      OR (first_successful_run_at IS NULL AND ? IS NOT NULL)
      OR (accepted_artifact_at IS NULL AND ? IS NOT NULL)
      OR (activated_at IS NULL AND (accepted_artifact_at IS NOT NULL OR ? IS NOT NULL)) THEN 1 ELSE 0 END,
    updated_at=MAX(updated_at,?) WHERE user_id=? AND revision=?`).bind(
    connectedAt, runAt, acceptedAt, acceptedAt, now, connectedAt, runAt, acceptedAt, acceptedAt, now, userId, expectedRevision,
  ).run();
}

async function parseAction(request: Request): Promise<ProgressAction | null> {
  let value: unknown;
  try { value = await request.json(); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["action", "currentStep", "expectedRevision", "draftTask"].includes(key))) return null;
  if (!["step", "dismiss", "resume", "save-draft", "prepare-task"].includes(String(body.action))) return null;
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) return null;
  if (body.currentStep !== undefined && !isStep(body.currentStep)) return null;
  if (body.action === "step" && !isStep(body.currentStep)) return null;
  const patch = body.action === "save-draft" ? draftFields.partial().safeParse(body.draftTask) : null;
  if (patch && (!patch.success || Object.keys(patch.data).length === 0)) return null;
  if (body.action !== "save-draft" && body.draftTask !== undefined) return null;
  if ((body.action === "save-draft" || body.action === "prepare-task") && body.currentStep !== undefined) return null;
  return { action: body.action as ProgressAction["action"], expectedRevision: Number(body.expectedRevision), ...(isStep(body.currentStep) ? { currentStep: body.currentStep } : {}), ...(patch?.success ? { draftTask: patch.data } : {}) };
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
    const update = action && (action.action === "save-draft" || action.action === "prepare-task")
      ? await updateDraft(env, identity, action, now, deps)
      : action ? await updateAction(db, identity.userId, action.expectedRevision, action.action as "step" | "dismiss" | "resume", action.currentStep, now) ? "saved" : "conflict" : "saved";
    if (update === "invalid") return Response.json({ error: "Invalid draft task answers, references or completion state." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (update === "conflict") {
      const current = await readStored(db, identity.userId);
      if (!current) throw new Error("Progress row unavailable.");
      return progressResponse(toProgress(current), 409);
    }
    // Save user action first; provider/run outages are represented as unknown evidence.
    const snapshot = await readStored(db, identity.userId);
    if (!snapshot) throw new Error("Progress row unavailable.");
    const evidence = await readEvidence(env, identity, deps, toProgress(snapshot));
    try { await persistEvidence(db, identity.userId, evidence, now, snapshot.revision); }
    catch {
      const saved = await readStored(db, identity.userId);
      if (!saved) throw new Error("Progress row unavailable.");
      return progressResponse(toProgress(saved));
    }
    const current = await readStored(db, identity.userId);
    if (!current) throw new Error("Progress row unavailable.");
    // A concurrent edit invalidates evidence read for the earlier draft snapshot.
    const unchanged = current.draft_task_json === snapshot.draft_task_json;
    return progressResponse(toProgress(current, unchanged ? evidence : undefined));
  } catch {
    return Response.json({ error: "Onboarding progress is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
