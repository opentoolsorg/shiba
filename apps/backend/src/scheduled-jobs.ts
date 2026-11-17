import { getAgentByName } from "agents/routing";
import { AUDIT_RETENTION_MS, pruneAuditLog } from "./audit.js";
import { automationsStub } from "./automations-stub.js";
import { pruneCapabilityInvocations } from "./capability-invocations.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";

export const scheduledJobs = {
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
  "automations.tick": async (env: Env) => {
    const response = await automationsStub(env).fetch(new Request("https://internal/internal/tick", { method: "POST" }));
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

export type ScheduledJobMessage = { job: keyof typeof scheduledJobs; scheduledAt: number };

// Automation dispatch awaits external work before persisting counters; no tick-wide claim exists.
export function isQueuedJob(job: ScheduledJobMessage["job"]): boolean {
  return job !== "automations.tick";
}

export async function runScheduledJobs(scheduledAt: number, env: Env): Promise<void> {
  const messages = (Object.keys(scheduledJobs) as ScheduledJobMessage["job"][])
    .map((job) => ({ job, scheduledAt }));
  const inline = Promise.allSettled(messages
    .filter(({ job }) => !env.JOBS_QUEUE || !isQueuedJob(job))
    .map(async ({ job }) => {
      try { await scheduledJobs[job](env, scheduledAt); }
      catch (error) {
        if (job === "audit.prune") console.warn(`audit prune failed: ${redactSecrets(String(error))}`);
        else console.error(`job ${job} failed`, redactSecrets(String(error)));
      }
    }));
  await Promise.all([
    inline,
    env.JOBS_QUEUE?.sendBatch(messages.filter(({ job }) => isQueuedJob(job)).map((body) => ({ body }))),
  ]);
}

export async function consumeScheduledJobs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const body = message.body as Partial<ScheduledJobMessage> | null;
    if (!body || typeof body.job !== "string" || !Object.hasOwn(scheduledJobs, body.job)
      || !isQueuedJob(body.job)
      || typeof body.scheduledAt !== "number" || !Number.isFinite(body.scheduledAt)) {
      console.warn("Unknown or invalid scheduled job", typeof body?.job === "string" ? redactSecrets(body.job) : "invalid");
      message.ack();
      return;
    }
    try {
      await scheduledJobs[body.job](env, body.scheduledAt);
      message.ack();
    } catch (error) {
      console.error(`job ${body.job} failed`, redactSecrets(String(error)));
      message.retry({ delaySeconds: 60 });
    }
  }));
}
