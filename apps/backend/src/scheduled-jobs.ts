import { getAgentByName } from "agents/routing";
import { AUDIT_RETENTION_MS, pruneAuditLog } from "./audit.js";
import { automationsStub } from "./automations-stub.js";
import { pruneCapabilityInvocations } from "./capability-invocations.js";
import type { Env } from "./env.js";
import { reportError } from "./observability.js";
import { redactSecrets } from "./security.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";

const jobRunners = {
  "learning.sweep": async (env: Env) => {
    if (env.AGENT_AUDIT === undefined) return;
    const learning = await import("./ports/learning/review.js");
    const { d1LearningPort } = await import("./ports/learning/d1-adapter.js");
    await learning.sweepIdleLearningThreads(env, d1LearningPort(env.AGENT_AUDIT));
  },
  "founder.stripe": async (env: Env) => (await import("./founder-stripe-runtime.js")).tickFounderStripeReads(env),
  "founder.meta": async (env: Env) => (await import("./founder-meta-runtime.js")).tickFounderMetaReads(env),
  "founder.hubspot": async (env: Env) => (await import("./founder-hubspot-runtime.js")).tickFounderHubSpotReads(env),
  "founder.reconcile": async (env: Env) => (await import("./founder-reconciliation-schedule-runtime.js")).tickFounderReconciliationSchedules(env),
  "founder.reads": async (env: Env) => (await import("./founder-auto-read-runtime.js")).tickFounderAutomaticReads(env),
  "founder.slack": async (env: Env) => (await import("./founder-automatic-slack-tick.js")).tickFounderAutomaticSlack(env),
  "founder.stripe-slack": async (env: Env) => (await import("./founder-automatic-slack-stripe-tick.js")).tickFounderStripeAutomaticSlack(env),
  "founder.reconcile-slack": async (env: Env) => (await import("./founder-reconciliation-slack-tick.js")).tickFounderReconciliationSlack(env),
  "slack.private-status": async (env: Env) => (await import("./slack-coworker-private-status.js")).tickSlackCoworkerPrivateStatus(env),
  "founder.reviews": async (env: Env) => (await import("./founder-review-schedules.js")).tickFounderReviewSchedules(env),
  "founder.connectors": async (env: Env) => (await import("./founder-connector-jobs.js")).tickFounderConnectorJobs(env),
  "automations.tick": async (env: Env, scheduledAt: number) => {
    const response = await automationsStub(env).fetch(new Request("https://internal/internal/tick", {
      method: "POST", headers: { "X-Shiba-Schedule-Slot": String(Math.floor(scheduledAt / 300_000)) },
    }));
    if (!response.ok) throw new Error(`automation tick failed: ${response.status}`);
  },
  "drafts.sweep": async (env: Env) => {
    const stub = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
    const response = await stub.fetch(new Request("https://internal/internal/sweep-drafts", { method: "POST" }));
    if (!response.ok) throw new Error(`stale draft sweep failed: ${response.status}`);
  },
  "audit.prune": async (env: Env, scheduledAt: number) => {
    if (env.AGENT_AUDIT === undefined) return;
    const cutoff = scheduledAt - AUDIT_RETENTION_MS;
    const [auditDeleted, invocationDeleted] = await Promise.all([
      pruneAuditLog(env, cutoff),
      pruneCapabilityInvocations(env, cutoff),
    ]);
    if (auditDeleted > 0) console.log(`audit prune deleted ${auditDeleted} row(s) older than 90 days`);
    if (invocationDeleted > 0) console.log(`capability invocation prune deleted ${invocationDeleted} row(s) older than 90 days`);
  },
} satisfies Record<string, (env: Env, scheduledAt: number) => Promise<unknown>>;

export const SCHEDULED_JOB_INTERVAL_MINUTES = 5;
export const scheduledJobs = jobRunners;
export const scheduledJobRegistry = Object.fromEntries(
  Object.keys(jobRunners).map((name) => [name, { everyMinutes: SCHEDULED_JOB_INTERVAL_MINUTES }]),
) as Record<keyof typeof jobRunners, { everyMinutes: number }>;

export type ScheduledJobMessage = { job: keyof typeof scheduledJobs; slot: number };
const SLOT_MS = SCHEDULED_JOB_INTERVAL_MINUTES * 60_000;

function dueJobs(scheduledAt: number): ScheduledJobMessage[] {
  const slot = Math.floor(scheduledAt / SLOT_MS);
  return (Object.keys(scheduledJobRegistry) as ScheduledJobMessage["job"][])
    .filter((job) => slot % (scheduledJobRegistry[job].everyMinutes / SCHEDULED_JOB_INTERVAL_MINUTES) === 0)
    .map((job) => ({ job, slot }));
}

export async function runScheduledJobs(scheduledAt: number, env: Env): Promise<void> {
  const messages = dueJobs(scheduledAt);
  const inline = Promise.allSettled(messages
    .filter(() => !env.JOBS_QUEUE)
    .map(async ({ job, slot }) => {
      try { await scheduledJobs[job](env, scheduledAt); }
      catch (error) {
        await reportError(env, "scheduled", error);
        if (job === "audit.prune") console.warn(`audit prune failed: ${redactSecrets(String(error))}`);
        else console.error(`job ${job} failed`, redactSecrets(String(error)));
      }
    }));
  await Promise.all([
    inline,
    env.JOBS_QUEUE?.sendBatch(messages.map((body) => ({ body }))),
  ]);
}

async function claimJobSlot(env: Env, job: ScheduledJobMessage["job"], slot: number): Promise<boolean> {
  const db = env.AGENT_AUDIT;
  if (!db) return true;
  await db.prepare(`DELETE FROM scheduled_job_slots WHERE slot < ?`).bind(slot - 2016).run();
  const result = await db.prepare(`INSERT OR IGNORE INTO scheduled_job_slots (job_name, slot, state, started_at)
    VALUES (?, ?, 'running', ?)`).bind(job, slot, Date.now()).run();
  if (result.meta.changes === 1) return true;
  return false;
}

async function finishJobSlot(env: Env, job: ScheduledJobMessage["job"], slot: number): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  await env.AGENT_AUDIT.prepare(`UPDATE scheduled_job_slots SET state = 'complete', finished_at = ?
    WHERE job_name = ? AND slot = ?`).bind(Date.now(), job, slot).run();
}

async function releaseJobSlot(env: Env, job: ScheduledJobMessage["job"], slot: number): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  await env.AGENT_AUDIT.prepare(`DELETE FROM scheduled_job_slots WHERE job_name = ? AND slot = ? AND state = 'running'`)
    .bind(job, slot).run();
}

export async function consumeScheduledJobs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const body = message.body as Partial<ScheduledJobMessage> | null;
    if (!body || typeof body.job !== "string" || !Object.hasOwn(scheduledJobs, body.job)
      || !Number.isSafeInteger(body.slot) || (body.slot as number) < 0) {
      console.warn("Unknown or invalid scheduled job", typeof body?.job === "string" ? redactSecrets(body.job) : "invalid");
      message.ack();
      return;
    }
    const slot = body.slot as number;
    let claimed: boolean;
    try {
      claimed = await claimJobSlot(env, body.job, slot);
      if (!claimed) {
        const current = env.AGENT_AUDIT && await env.AGENT_AUDIT.prepare(`SELECT state FROM scheduled_job_slots WHERE job_name = ? AND slot = ?`)
          .bind(body.job, slot).first<{ state: string }>();
        if (current?.state === "complete") message.ack();
        else message.retry({ delaySeconds: 60 });
        return;
      }
      await scheduledJobs[body.job](env, slot * SLOT_MS);
      await finishJobSlot(env, body.job, slot);
      message.ack();
    } catch (error) {
      await reportError(env, "scheduled", error);
      await releaseJobSlot(env, body.job, slot).catch(() => undefined);
      console.error(`job ${body.job} failed`, redactSecrets(String(error)));
      message.retry({ delaySeconds: 60 });
    }
  }));
}
