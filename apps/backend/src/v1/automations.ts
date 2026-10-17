import type { Automation, AutomationTrigger } from "../automations.js";
import { automationsStub } from "../automations-stub.js";
import type { V1Context } from "./context.js";

type PublicAutomation = Omit<Automation, "webhookSecret"> & { hasWebhookSecret: boolean };

const notImplemented = (detail: string) =>
  Response.json({ ok: false, error: "not_implemented", code: "not_implemented", detail }, { status: 501 });
const invalid = (detail?: string) =>
  Response.json({ ok: false, error: "invalid_request", ...(detail ? { detail } : {}) }, { status: 400 });
const notFound = () => Response.json({ ok: false, error: "automation_not_found" }, { status: 404 });

// Hoplite eventKind <-> shiba github/slack trigger; only exact equivalents map.
const EVENT_KINDS: Record<string, AutomationTrigger> = {
  "github.pull_request.opened": { kind: "github", events: ["pull_request:opened"] },
  "github.pull_request.closed": { kind: "github", events: ["pull_request:closed"] },
  "github.pull_request.updated": { kind: "github", events: ["pull_request:synchronize"] },
  "slack.message.posted": { kind: "slack" },
};
// Fields shiba's automation record cannot hold; a non-null value is a 501, never a silent drop.
const UNSUPPORTED = ["modelId", "workflow", "conditions", "sentryBindingId", "sentryTriggerPolicy", "slack", "targetThreadId", "maxSpendPerThreadMicros"];
const CREATE_KEYS = new Set([...UNSUPPORTED, "triggers", "eventKind", "isDraft", "name", "repoFullName", "enabled", "triggerKind", "schedule", "prompt", "clientOperationId"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (ms: number | undefined) => ms === undefined ? null : new Date(ms).toISOString();

// Project id = the GitHub repoUrl (as threads.ts reports it); `owner/repo` is accepted.
function projectRepo(raw: string): string | null {
  const match = raw.trim().match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}
const sameRepo = (a: string, b: string) => projectRepo(a)?.toLowerCase() === b.toLowerCase();

function eventKindOf(trigger: AutomationTrigger): string | null {
  if (trigger.kind === "slack") return "slack.message.posted";
  if (trigger.kind !== "github") return null;
  return Object.entries(EVENT_KINDS).find(([, mapped]) => mapped.kind === "github" && mapped.events[0] === trigger.events[0])?.[0] ?? null;
}

function toHoplite(automation: PublicAutomation, projectId: string) {
  // Manual triggers are implicit in Hoplite (every automation is runnable), so they are not listed.
  const triggers = automation.triggers.filter((trigger) => trigger.kind !== "manual").map((trigger, index) => ({
    id: `t${index}`, triggerKind: trigger.kind === "schedule" ? "schedule" : "webhook", eventKind: eventKindOf(trigger),
    schedule: trigger.kind === "schedule" ? { mode: "cron", expression: trigger.cron, timezone: "UTC" } : null }));
  const first = triggers[0];
  return { id: automation.id, projectId, repoFullName: automation.repoUrl.replace(/^https:\/\/github\.com\//, ""),
    // No name field on the record: the prompt's first line stands in.
    name: automation.prompt.split("\n")[0]!.trim().slice(0, 120), enabled: automation.enabled, prompt: automation.prompt,
    triggerKind: first?.triggerKind ?? "webhook", eventKind: first?.eventKind ?? null, schedule: first?.schedule ?? null, triggers,
    modelId: null, workflow: null, conditions: null, sentryBindingId: null, sentryTriggerPolicy: null, targetThreadId: null,
    isDraft: false, maxSpendPerThreadMicros: null, webhookTokenPrefix: null, nextRunAt: null, lastRunAt: iso(automation.lastTriggeredAt) };
}

// The DO keeps no execution log: the last fire and the last gate skip are the only persisted outcomes.
function executions(automation: PublicAutomation, projectId: string) {
  const triggerKind = automation.triggers.some((trigger) => trigger.kind === "schedule") ? "schedule" : "webhook";
  const base = { automationId: automation.id, projectId, triggerKind, threadId: null, runId: null, payloadSummary: null,
    threadTitle: null, runDurationMs: null, runStatus: null, runFailureCode: null };
  const items = [];
  if (automation.lastTriggeredAt !== undefined) {
    const id = `${automation.id}:fired:${automation.lastTriggeredAt}`;
    items.push({ ...base, id, dedupeKey: id, status: "accepted", error: null, at: automation.lastTriggeredAt });
  }
  if (automation.lastSkip) {
    const id = `${automation.id}:skipped:${automation.lastSkip.at}`;
    items.push({ ...base, id, dedupeKey: id, status: "failed", error: automation.lastSkip.reason, at: automation.lastSkip.at });
  }
  return items.sort((a, b) => b.at - a.at).map(({ at, ...item }) => ({ ...item, createdAt: iso(at), updatedAt: iso(at) }));
}

function toTrigger(raw: Record<string, unknown>): AutomationTrigger | Response {
  if (raw.triggerKind === "schedule") {
    const schedule = raw.schedule;
    if (raw.eventKind !== undefined && raw.eventKind !== null) return invalid();
    if (!isObject(schedule)) return invalid("schedule triggers need a schedule.");
    if (schedule.mode === "interval") return notImplemented("Interval schedules are not supported; use a five-field cron.");
    if (schedule.mode !== "cron" || typeof schedule.expression !== "string" || typeof schedule.timezone !== "string") return invalid();
    if (!["UTC", "Etc/UTC"].includes(schedule.timezone)) return notImplemented("Cron schedules are evaluated in UTC only.");
    return { kind: "schedule", cron: schedule.expression };
  }
  if (raw.triggerKind !== "webhook") return invalid();
  if (raw.schedule !== undefined && raw.schedule !== null) return invalid();
  if (raw.eventKind === undefined || raw.eventKind === null) return { kind: "webhook" };
  if (typeof raw.eventKind !== "string") return invalid();
  return EVENT_KINDS[raw.eventKind] ?? notImplemented(`eventKind ${raw.eventKind} has no shiba trigger equivalent.`);
}

async function idempotentId(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `v1-${[...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function jsonBody(ctx: V1Context): Promise<Record<string, unknown> | null> {
  try {
    const text = await ctx.request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    return isObject(parsed) ? parsed : null;
  } catch { return null; }
}

export async function handleAutomations(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/automations(?:\/(status)|\/([^/]+)(?:\/(executions|run))?)?$/);
  if (!match) return null;
  const action = match[2] ?? match[4] ?? (match[3] ? "item" : "collection");
  const methods: Record<string, string[]> = { collection: ["GET", "POST"], status: ["GET"], executions: ["GET"], run: ["POST"], item: ["PATCH", "DELETE"] };
  if (!methods[action]!.includes(ctx.request.method)) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let repoUrl: string | null = null;
  let automationId: string | undefined;
  try { repoUrl = projectRepo(decodeURIComponent(match[1]!)); automationId = match[3] ? decodeURIComponent(match[3]) : undefined; }
  catch { /* falls through to 400 */ }
  if (!repoUrl) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
  const projectId = repoUrl;
  const key = ctx.request.headers.get("Idempotency-Key");
  if (key !== null && (!key || key.length > 128)) return Response.json({ ok: false, error: "invalid_idempotency_key" }, { status: 400 });
  const body = ctx.request.method === "GET" || ctx.request.method === "DELETE" ? {} : await jsonBody(ctx);
  if (!body) return invalid();
  const op = body.clientOperationId;
  if (op !== undefined && (typeof op !== "string" || !op || op.length > 64)) return invalid();
  if (action === "executions") {
    const limit = ctx.url.searchParams.get("limit") ?? "100";
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) return invalid();
  }

  const stub = automationsStub(ctx.env);
  const call = (method: string, path: string, input?: unknown) => stub.fetch(new Request(`https://internal${path}`, { method,
    ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }) }));
  const listAll = async () => {
    const response = await call("GET", "/api/automations");
    if (!response.ok) throw new Error(`automations_${response.status}`);
    return (await response.json() as { automations: PublicAutomation[] }).automations;
  };
  const list = async () => (await listAll()).filter((automation) => sameRepo(automation.repoUrl, projectId));

  try {
    if (action === "collection" && ctx.request.method === "GET") {
      return Response.json({ ok: true, automations: (await list()).map((automation) => toHoplite(automation, projectId)) });
    }
    if (action === "status") {
      const statuses = (await list()).map((automation) => {
        const latest = executions(automation, projectId)[0];
        // runCount is lifetime, not 30-day, and run outcomes are not tracked back here.
        return { automationId: automation.id, recentExecutions: executions(automation, projectId).map(({ id, status, createdAt }) => ({ id, status, runStatus: null, createdAt })),
          lastStatus: latest?.status ?? null, lastRunStatus: null, lastError: latest?.error ?? null,
          lastExecutionAt: latest?.createdAt ?? null, runs30d: automation.runCount, succeeded30d: 0 };
      });
      return Response.json({ ok: true, statuses, totals: { runs30d: statuses.reduce((sum, status) => sum + status.runs30d, 0), succeeded30d: 0 } });
    }
    if (action === "collection") {
      if (Object.keys(body).some((field) => !CREATE_KEYS.has(field))) return invalid();
      if (typeof body.name !== "string" || !body.name || body.name.length > 120 || typeof body.prompt !== "string" ||
          !body.prompt.trim() || body.prompt.length > 100_000 || (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
          (body.isDraft !== undefined && typeof body.isDraft !== "boolean")) return invalid();
      if (body.repoFullName !== undefined && body.repoFullName !== null &&
          (typeof body.repoFullName !== "string" || !sameRepo(body.repoFullName, projectId))) return invalid("repoFullName must match the project.");
      const unsupported = UNSUPPORTED.filter((field) => body[field] !== undefined && body[field] !== null);
      if (body.isDraft === true) unsupported.push("isDraft");
      if (unsupported.length) return notImplemented(`Unsupported automation fields: ${unsupported.join(", ")}.`);
      const rawTriggers = body.triggers === undefined ? [body] : body.triggers;
      if (!Array.isArray(rawTriggers) || rawTriggers.length === 0 || !rawTriggers.every(isObject)) return invalid();
      const triggers: AutomationTrigger[] = [];
      for (const raw of rawTriggers) {
        const trigger = toTrigger(raw);
        if (trigger instanceof Response) return trigger;
        triggers.push(trigger);
      }
      // POST .../run needs a manual trigger on the shiba record.
      triggers.push({ kind: "manual" });
      const replayKey = key ?? op;
      const id = replayKey === undefined ? undefined : await idempotentId(replayKey as string);
      if (id !== undefined) {
        const existing = (await listAll()).find((automation) => automation.id === id);
        // Ids are global: replaying a key from another project must not overwrite that record.
        if (existing && !sameRepo(existing.repoUrl, projectId)) return Response.json({ ok: false, error: "idempotency_key_conflict" }, { status: 409 });
        if (existing) return Response.json({ ok: true, automation: toHoplite(existing, projectId), secretUnavailable: existing.hasWebhookSecret }, { status: 201 });
      }
      const response = await call("POST", "/api/automations", { ...(id ? { id } : {}), prompt: body.prompt, repoUrl, triggers,
        enabled: body.enabled ?? true });
      const created = await response.json() as { automation?: PublicAutomation; webhookSecret?: string | null; error?: string };
      if (response.status === 400) return invalid(created.error);
      if (!response.ok || !created.automation) throw new Error(`automations_${response.status}`);
      // The secret is shown once, here; the DO never returns it again.
      return Response.json({ ok: true, automation: toHoplite(created.automation, projectId),
        ...(created.webhookSecret ? { webhookToken: created.webhookSecret, webhookUrl: `${ctx.url.origin}/api/automations/${encodeURIComponent(created.automation.id)}/trigger` } : {}) },
        { status: 201 });
    }

    const automation = (await list()).find((candidate) => candidate.id === automationId);
    if (!automation) return notFound();
    const path = `/api/automations/${encodeURIComponent(automation.id)}`;
    if (action === "executions") {
      return Response.json({ ok: true, executions: executions(automation, projectId).slice(0, Number(ctx.url.searchParams.get("limit") ?? "100")) });
    }
    if (action === "item" && ctx.request.method === "DELETE") {
      const response = await call("DELETE", path);
      if (response.status === 404) return notFound();
      if (!response.ok) throw new Error(`automations_${response.status}`);
      return Response.json({ ok: true, result: { id: automation.id } });
    }
    if (action === "item") {
      const ignored = new Set(["clientOperationId", "webhookOperationId", "enabled", "prompt"]);
      if (Object.keys(body).some((field) => !CREATE_KEYS.has(field) && field !== "webhookOperationId") ||
          (body.webhookOperationId !== undefined && (typeof body.webhookOperationId !== "string" || !body.webhookOperationId || body.webhookOperationId.length > 64)) ||
          (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
          (body.prompt !== undefined && (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 100_000))) return invalid();
      const unsupported = Object.keys(body).filter((field) => !ignored.has(field));
      if (unsupported.length) return notImplemented(`Only enabled and prompt can be updated; got ${unsupported.join(", ")}.`);
      const response = await call("PATCH", path, { enabled: body.enabled, prompt: body.prompt });
      const updated = await response.json() as { automation?: PublicAutomation; error?: string };
      if (response.status === 404) return notFound();
      if (response.status === 400) return invalid(updated.error);
      if (!response.ok || !updated.automation) throw new Error(`automations_${response.status}`);
      return Response.json({ ok: true, automation: toHoplite(updated.automation, projectId) });
    }
    // run
    if (!automation.triggers.some((trigger) => trigger.kind === "manual")) {
      return Response.json({ ok: false, error: "automation_not_runnable", detail: "Automation has no manual trigger." }, { status: 409 });
    }
    const response = await call("POST", `${path}/run`);
    if (response.status === 404) return notFound();
    if (!response.ok) throw new Error(`automations_${response.status}`);
    const fired = ((await response.json()) as { fired?: number }).fired ?? 0;
    const after = (await list()).find((candidate) => candidate.id === automation.id) ?? automation;
    const at = Date.now();
    const id = `${automation.id}:run:${at}`;
    // The DO answers once the run is queued for approval; no thread or run id exists yet.
    return Response.json({ ok: true, execution: { id, automationId: automation.id, projectId,
      triggerKind: automation.triggers.some((trigger) => trigger.kind === "schedule") ? "schedule" : "webhook", dedupeKey: id,
      status: fired > 0 ? "accepted" : "failed", error: fired > 0 ? null : after.lastSkip?.reason ?? "Automation was skipped.",
      threadId: null, runId: null, payloadSummary: null, createdAt: iso(at), updatedAt: iso(at) } }, { status: 202 });
  } catch {
    return Response.json({ ok: false, error: "automations_unavailable" }, { status: 502 });
  }
}
