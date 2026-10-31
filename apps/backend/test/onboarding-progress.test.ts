import { describe, expect, it } from "vitest";
import { handleOnboardingProgress, readAcceptedDeliverableEvidence, readSuccessfulRunEvidence, resolvePreparedOnboardingDraft, readOnboardingSourceRefs, type OnboardingIdentity, type OnboardingProgress, type OnboardingSourceRef } from "../src/onboarding-progress.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import { ensureBetterAuthSchema } from "../src/better-auth.js";
import type { Env } from "../src/env.js";
import { createWebSession } from "../src/web-sessions.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function context() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, BETTER_AUTH_SECRET: "s".repeat(32) } as unknown as Env;
  let identity: OnboardingIdentity | null = { userId: "auth-user-a", ownerEmail: "a@example.test" };
  let now = 100;
  let connected: boolean | null = false;
  let run: boolean | null = false;
  let acceptedArtifact: boolean | null = false;
  const deps = {
    resolveIdentity: async () => identity,
    readProviders: async () => {
      if (connected === null) throw new Error("provider status unavailable");
      return [{ connection: { phase: connected ? "connected" : "disconnected" } } as never];
    },
    readSuccessfulRun: async () => run,
    readAcceptedDeliverable: async () => acceptedArtifact,
    now: () => now,
  };
  return {
    env, sqlite, deps,
    setIdentity(value: OnboardingIdentity | null) { identity = value; },
    setNow(value: number) { now = value; },
    setEvidence(provider: boolean | null, successful: boolean | null, accepted: boolean | null = false) { connected = provider; run = successful; acceptedArtifact = accepted; },
  };
}

async function call(ctx: ReturnType<typeof context>, method = "GET", body?: unknown, origin = "https://shiba.test") {
  const response = await handleOnboardingProgress(new Request("https://shiba.test/api/onboarding/progress", {
    method,
    ...(body === undefined ? {} : { headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }), ctx.env, ctx.deps);
  if (!response) throw new Error("Progress route did not match.");
  return response as Omit<Response, "json"> & { json(): Promise<OnboardingProgress> };
}

async function saveDraft(ctx: ReturnType<typeof context>, draftTask: Record<string, unknown>) {
  const current = await (await call(ctx)).json();
  return call(ctx, "POST", { action: "save-draft", expectedRevision: current.revision, draftTask });
}

async function prepareDraft(ctx: ReturnType<typeof context>) {
  const saved = await (await saveDraft(ctx, { goal: "Research buyer needs", audience: "Product team", acceptance: "Sourced editable brief" })).json();
  return call(ctx, "POST", { action: "prepare-task", expectedRevision: saved.revision });
}

describe("server-owned onboarding progress", () => {
  it("persists the step across dismiss and resume without treating dismissal as activation", async () => {
    const ctx = context();
    const initial = await (await call(ctx)).json() as { revision: number; currentStep: string };
    expect(initial).toMatchObject({ revision: 0, currentStep: "channels" });
    const moved = await call(ctx, "POST", { action: "step", currentStep: "models", expectedRevision: 0 });
    expect(await moved.json()).toMatchObject({ currentStep: "models", revision: 1, activatedAt: null });
    ctx.setNow(300);
    ctx.setEvidence(null, null, null);
    expect(await (await call(ctx, "POST", { action: "dismiss", currentStep: "employee", expectedRevision: 1 })).json()).toMatchObject({ currentStep: "employee", dismissedAt: 300, revision: 2, activatedAt: null });
    expect(await (await call(ctx, "POST", { action: "resume", expectedRevision: 2 })).json()).toMatchObject({ currentStep: "employee", dismissedAt: null });
    expect(ctx.sqlite.prepare("SELECT current_step FROM user_onboarding_progress WHERE user_id='auth-user-a'").get()).toEqual({ current_step: "employee" });
  });

  it("isolates by immutable Better Auth id and activates only from the accepted prepared goal", async () => {
    const ctx = context();
    await prepareDraft(ctx);
    ctx.setEvidence(true, true, false);
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: null, acceptedArtifactAt: null, evidence: { connectedProvider: true, successfulRun: true, acceptedDeliverable: false } });
    ctx.setNow(250);
    ctx.setEvidence(false, true, true);
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: 250, acceptedArtifactAt: 250, evidence: { connectedProvider: false, successfulRun: true, acceptedDeliverable: true } });
    ctx.setIdentity({ userId: "auth-user-b", ownerEmail: "b@example.test" });
    expect(await (await call(ctx)).json()).toMatchObject({ currentStep: "channels", activatedAt: null });
    expect(ctx.sqlite.prepare("SELECT COUNT(*) AS count FROM user_onboarding_progress").get()).toEqual({ count: 2 });
  });

  it.each([false, null])("accepts a useful goal output without inventing provider readiness (%s)", async (provider) => {
    const ctx = context();
    await prepareDraft(ctx);
    ctx.setEvidence(provider, false, true);
    expect(await (await call(ctx)).json()).toMatchObject({
      activatedAt: 100, acceptedArtifactAt: 100, connectionVerifiedAt: null, firstSuccessfulRunAt: null,
      evidence: { connectedProvider: provider, successfulRun: false, acceptedDeliverable: true },
    });
  });

  it("rejects stale, cross-origin, unauthenticated, and browser-supplied identity updates", async () => {
    const ctx = context();
    await call(ctx);
    expect((await call(ctx, "POST", { action: "step", currentStep: "agent", expectedRevision: 0, userId: "other" })).status).toBe(400);
    expect((await call(ctx, "POST", { action: "dismiss", expectedRevision: 0 }, "https://attacker.test")).status).toBe(403);
    await call(ctx, "POST", { action: "dismiss", expectedRevision: 0 });
    const stale = await call(ctx, "POST", { action: "resume", expectedRevision: 0 });
    expect(stale.status).toBe(409);
    ctx.setIdentity(null);
    expect((await call(ctx)).status).toBe(401);
  });

  it("preserves user updates when evidence is unavailable", async () => {
    const ctx = context();
    ctx.setEvidence(null, null, null);
    const response = await call(ctx, "POST", { action: "step", currentStep: "agent", expectedRevision: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currentStep: "agent", evidence: { connectedProvider: null, successfulRun: null, acceptedDeliverable: false } });
  });

  it("checks completed runs in authorized named web sessions", async () => {
    const ctx = context();
    const email = "named@example.test";
    const session = createWebSession(email, { name: "Employee" });
    const requested: string[] = [];
    const evidence = await readSuccessfulRunEvidence(ctx.env, email, async (_env, name) => {
      requested.push(name);
      return { fetch: async (input) => {
        const path = String(input);
        if (name === email && path.endsWith("/internal/web-sessions")) return Response.json({ sessions: [session] });
        if (name === session.agentName && path.endsWith("/api/runs")) return Response.json({ runs: [{ status: "completed" }] });
        return Response.json({ runs: [] });
      } };
    });
    expect(evidence).toBe(true);
    expect(requested).toContain(session.agentName);
  });

  it("requires a completed run with an approved deliverable, not just any completed run", async () => {
    const ctx = context();
    const primaryRun = { status: "completed", draftTaskId: "draft_current", draftTaskVersion: 2, deliverables: [{ artifactId: "artifact_1", version: 1, path: "draft.md", sha256: "a".repeat(64), review: { status: "pending_review" } }] };
    const primaryArtifact = primaryRun.deliverables[0];
    if (!primaryArtifact) throw new Error("Missing test artifact");
    const runRows = [
      primaryRun,
      { status: "failed", deliverables: [{ artifactId: "artifact_2", version: 1, path: "other.md", sha256: "b".repeat(64), review: { status: "approved" } }] },
    ];
    const read = async () => readAcceptedDeliverableEvidence(ctx.env, "a@example.test", async () => ({
      fetch: async (input) => String(input).endsWith("/internal/web-sessions")
        ? Response.json({ sessions: [] })
        : String(input).endsWith("/api/employee-drafts") ? Response.json({ drafts: [] }) : Response.json({ runs: runRows }),
    }), "draft_current", 2);
    expect(await read()).toBe(false);
    primaryArtifact.review.status = "approved";
    expect(await read()).toBe(true);
    primaryRun.draftTaskVersion = 1;
    expect(await read()).toBe(false);
    primaryRun.draftTaskVersion = 2;
    primaryRun.draftTaskId = "unrelated_old_draft";
    expect(await read()).toBe(false);
  });

  it("does not carry forward legacy activation that was based only on a successful run", async () => {
    const ctx = context();
    ctx.sqlite.exec(`CREATE TABLE user_onboarding_progress (
      user_id TEXT PRIMARY KEY,current_step TEXT NOT NULL,dismissed_at INTEGER,
      connection_verified_at INTEGER,first_successful_run_at INTEGER,activated_at INTEGER,
      revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    )`);
    ctx.sqlite.prepare(`INSERT INTO user_onboarding_progress
      VALUES ('auth-user-a','employee',NULL,10,20,30,4,1,30)`).run();
    const progress = await (await call(ctx)).json() as { activatedAt: number | null; acceptedArtifactAt: number | null; revision: number };
    expect(progress).toMatchObject({ activatedAt: null, acceptedArtifactAt: null, revision: 5 });
  });

  it("retains free answers, template hints and skips across dismiss, refresh and resume", async () => {
    const ctx = context();
    const saved = await (await saveDraft(ctx, { goal: "Buyer report", audience: "Team", acceptance: "Cited draft",
      roleAnswer: "Founder", helpAnswer: "Research", contextAnswer: "Use supplied brief only", employeeAnswer: "Research specialist",
      connectionAnswer: "Skip connections for now", currentStep: "connections", employeeTemplateId: "research", employeeTemplateVersion: 1,
      completedSteps: ["goal", "audience", "acceptance", "role", "help", "employee"], skippedSteps: ["context", "connections"] })).json() as OnboardingProgress;
    expect(saved).toMatchObject({ schemaVersion: 2, draftTask: { version: 1, preparedAt: null, employeeId: null } });
    expect(saved.draftTaskId).toMatch(/^draft_[a-f0-9-]{36}$/);
    const dismissed = await (await call(ctx, "POST", { action: "dismiss", expectedRevision: saved.revision })).json();
    await call(ctx, "POST", { action: "resume", expectedRevision: dismissed.revision });
    expect((await (await call(ctx)).json()).draftTask).toEqual(saved.draftTask);
    ctx.setIdentity({ userId: "other", ownerEmail: "other@example.test" });
    expect(await (await call(ctx)).json()).toMatchObject({ draftTaskId: null, draftTask: null });
  });

  it("prepares one retained draft without launching work, preserves duplicate prepare and bumps version on edits", async () => {
    const ctx = context();
    const prepared = await (await prepareDraft(ctx)).json() as OnboardingProgress;
    expect(prepared.draftTask).toMatchObject({ preparedAt: 100, version: 1, currentStep: "review", completedSteps: ["review"] });
    ctx.setNow(200);
    const again = await (await call(ctx, "POST", { action: "prepare-task", expectedRevision: prepared.revision })).json();
    expect(again).toMatchObject({ draftTaskId: prepared.draftTaskId, revision: prepared.revision, draftTask: { preparedAt: 100, version: 1 } });
    const edited = await (await saveDraft(ctx, { audience: "Executive team" })).json();
    expect(edited).toMatchObject({ draftTaskId: prepared.draftTaskId, draftTask: { version: 2, preparedAt: null, sourceRefs: [], completedSteps: [] } });
    const stale = await call(ctx, "POST", { action: "save-draft", expectedRevision: prepared.revision, draftTask: { goal: "overwrite" } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).draftTask?.audience).toBe("Executive team");
  });

  it("rejects forged authority, invalid completions, stale employee pins and incomplete preparation", async () => {
    const ctx = context();
    for (const patch of [{ draftTaskId: "forged" }, { preparedAt: 1 }, { version: 99 }, { sourceRefs: [] },
      { completedSteps: ["connections"] }, { completedSteps: ["goal"] }, { skippedSteps: ["goal"], completedSteps: ["goal"], goal: "Brief" },
      { employeeId: "foreign", employeeVersion: 1 }, { employeeId: "missing" }, { employeeTemplateId: "invented", employeeTemplateVersion: 1 },
      { sourceIds: ["same", "same"] }, { roleAnswer: "x".repeat(4001) }]) {
      expect((await saveDraft(ctx, patch)).status).toBe(400);
    }
    const saved = await (await saveDraft(ctx, { goal: "Only a goal" })).json();
    expect((await call(ctx, "POST", { action: "prepare-task", expectedRevision: saved.revision })).status).toBe(400);
    ctx.setEvidence(true, true, true);
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: null, acceptedArtifactAt: null, evidence: { acceptedDeliverable: false } });
  });

  it("does not activate from historical artifacts without a prepared goal", async () => {
    const ctx = context();
    ctx.setEvidence(true, true, true);
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: null, acceptedArtifactAt: null });
    expect((await (await saveDraft(ctx, { goal: "New goal" })).json()).activatedAt).toBeNull();
  });

  it("retains an oversized editable brief but refuses preparation without truncation", async () => {
    const ctx = context();
    const saved = await (await saveDraft(ctx, { goal: "g".repeat(2000), audience: "a".repeat(2000), acceptance: "Cited draft" })).json();
    expect((await call(ctx, "POST", { action: "prepare-task", expectedRevision: saved.revision })).status).toBe(400);
    expect((await (await call(ctx)).json()).draftTask?.goal).toHaveLength(2000);
  });

  it("clears legacy artifact activation with no goal binding during additive migration", async () => {
    const ctx = context();
    ctx.sqlite.exec(`CREATE TABLE user_onboarding_progress (
      user_id TEXT PRIMARY KEY,current_step TEXT NOT NULL,dismissed_at INTEGER,
      connection_verified_at INTEGER,first_successful_run_at INTEGER,accepted_artifact_at INTEGER,activated_at INTEGER,
      revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    )`);
    ctx.sqlite.prepare(`INSERT INTO user_onboarding_progress VALUES ('auth-user-a','employee',NULL,10,20,25,30,4,1,30)`).run();
    expect(await (await call(ctx)).json()).toMatchObject({ acceptedArtifactAt: null, activatedAt: null, revision: 5, draftTaskId: null });
    expect(await (await call(ctx)).json()).toMatchObject({ revision: 5 });
  });

  it("serializes simultaneous first-draft saves with one stable retained id", async () => {
    const ctx = context();
    await call(ctx);
    const results = await Promise.all(["First", "Second"].map((goal) => call(ctx, "POST", { action: "save-draft", expectedRevision: 0, draftTask: { goal } })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const [a, b] = await Promise.all(results.map((response) => response.json()));
    if (!a?.draftTask || !b?.draftTask) throw new Error("Missing saved draft responses");
    expect(a.draftTaskId).toBe(b.draftTaskId);
    expect(a.draftTask.goal).toBe(b.draftTask.goal);
  });

  it("fences evidence when a concurrent goal edit wins during its read", async () => {
    const ctx = context();
    await prepareDraft(ctx);
    ctx.setEvidence(true, true, false);
    ctx.deps.readAcceptedDeliverable = async () => {
      const current = ctx.sqlite.prepare("SELECT draft_task_json FROM user_onboarding_progress WHERE user_id='auth-user-a'").get() as { draft_task_json: string };
      const draft = JSON.parse(current.draft_task_json);
      draft.goal = "Changed while reading evidence";
      draft.version += 1;
      draft.preparedAt = null;
      ctx.sqlite.prepare("UPDATE user_onboarding_progress SET draft_task_json=?,revision=revision+1 WHERE user_id='auth-user-a'").run(JSON.stringify(draft));
      return true;
    };
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: null, acceptedArtifactAt: null, draftTask: { version: 2 }, evidence: { acceptedDeliverable: null } });
  });

  it("returns conflict when a duplicate prepare races an edit while sources are validated", async () => {
    const ctx = context();
    const prepared = await (await prepareDraft(ctx)).json() as OnboardingProgress;
    const response = await handleOnboardingProgress(new Request("https://shiba.test/api/onboarding/progress", {
      method: "POST", headers: { Origin: "https://shiba.test", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare-task", expectedRevision: prepared.revision }),
    }), ctx.env, { ...ctx.deps, readSourceRefs: async () => {
      const draft = { ...prepared.draftTask, goal: "Concurrent replacement", version: 2, preparedAt: null };
      ctx.sqlite.prepare("UPDATE user_onboarding_progress SET draft_task_json=?,revision=revision+1 WHERE user_id='auth-user-a'").run(JSON.stringify(draft));
      return [];
    } });
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ draftTask: { goal: "Concurrent replacement", preparedAt: null } });
  });

  it("resolves execution handoff only for the current auth owner and current configured employee", async () => {
    const ctx = context();
    await ensureBetterAuthSchema(ctx.env);
    ctx.sqlite.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('auth-user-a','A','a@example.test',1,1,1)`).run();
    const config = { name: "Research", emoji: "R", instructions: "Produce a draft", harness: "opencode" as const };
    const employee = await createCustomAgent(ctx.env as Env & { AGENT_AUDIT: D1Database }, "self-hosted", "researcher", config);
    await saveDraft(ctx, { employeeId: employee.id, employeeVersion: employee.version });
    const prepared = await (await prepareDraft(ctx)).json() as OnboardingProgress;
    if (!prepared.draftTaskId || !prepared.draftTask) throw new Error("Missing prepared test draft");
    const reference = { draftTaskId: prepared.draftTaskId, version: prepared.draftTask.version };
    expect(await resolvePreparedOnboardingDraft(ctx.env, "a@example.test", reference)).toMatchObject({ ...reference, draftTask: { employeeId: employee.id } });
    expect(await resolvePreparedOnboardingDraft(ctx.env, "b@example.test", reference)).toBeNull();
    expect(await resolvePreparedOnboardingDraft(ctx.env, "a@example.test", { ...reference, version: reference.version + 1 })).toBeNull();
    await updateCustomAgent(ctx.env as Env & { AGENT_AUDIT: D1Database }, "self-hosted", employee.id, { ...config, instructions: "Changed policy" }, employee.version);
    expect(await resolvePreparedOnboardingDraft(ctx.env, "a@example.test", reference)).toBeNull();
    ctx.sqlite.prepare(`UPDATE "user" SET email='new@example.test' WHERE id='auth-user-a'`).run();
    expect(await resolvePreparedOnboardingDraft(ctx.env, "a@example.test", reference)).toBeNull();
  });

  it("pins managed source versions and rejects changed source snapshots", async () => {
    const ctx = context();
    const source = { id: "memsrc_123", version: 1, sha256: "a".repeat(64), content: "Untrusted source", title: "Brief" };
    const requested: string[] = [];
    ctx.env.Memory = { idFromName: (name: string) => name, get: (name: string) => {
      requested.push(name);
      return { fetch: async () => Response.json({ snapshot: { sources: [source] } }) };
    } } as unknown as DurableObjectNamespace;
    const refs: OnboardingSourceRef[] = [{ id: source.id, version: 1, sha256: source.sha256 }];
    expect(await readOnboardingSourceRefs(ctx.env, "a@example.test", [source.id])).toEqual(refs);
    expect(requested[0]).toMatch(/^owner-memory:/);
    await saveDraft(ctx, { sourceIds: [source.id] });
    const prepared = await (await prepareDraft(ctx)).json() as OnboardingProgress;
    expect(prepared.draftTask?.sourceRefs).toEqual(refs);
    source.version = 2;
    source.sha256 = "b".repeat(64);
    expect(await readOnboardingSourceRefs(ctx.env, "a@example.test", [source.id], refs)).toBeNull();
    const updated = await (await call(ctx, "POST", { action: "prepare-task", expectedRevision: prepared.revision })).json();
    if (!prepared.draftTask) throw new Error("Missing prepared test draft");
    expect(updated.draftTask?.version).toBe(prepared.draftTask.version + 1);
    expect(updated.draftTask?.sourceRefs[0]?.version).toBe(2);
    ctx.env.Memory = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 404 }) }) } as unknown as DurableObjectNamespace;
    expect((await call(ctx, "POST", { action: "prepare-task", expectedRevision: updated.revision })).status).toBe(400);
  });
});
