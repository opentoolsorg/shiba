import { describe, expect, it } from "vitest";
import { handleOnboardingProgress, readSuccessfulRunEvidence, type OnboardingIdentity } from "../src/onboarding-progress.js";
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
  const deps = {
    resolveIdentity: async () => identity,
    readProviders: async () => {
      if (connected === null) throw new Error("provider status unavailable");
      return [{ connection: { phase: connected ? "connected" : "disconnected" } } as never];
    },
    readSuccessfulRun: async () => run,
    now: () => now,
  };
  return {
    env, sqlite, deps,
    setIdentity(value: OnboardingIdentity | null) { identity = value; },
    setNow(value: number) { now = value; },
    setEvidence(provider: boolean | null, successful: boolean | null) { connected = provider; run = successful; },
  };
}

async function call(ctx: ReturnType<typeof context>, method = "GET", body?: unknown, origin = "https://shiba.test") {
  const response = await handleOnboardingProgress(new Request("https://shiba.test/api/onboarding/progress", {
    method,
    ...(body === undefined ? {} : { headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }), ctx.env, ctx.deps);
  if (!response) throw new Error("Progress route did not match.");
  return response;
}

describe("server-owned onboarding progress", () => {
  it("persists the step across dismiss and resume without treating dismissal as activation", async () => {
    const ctx = context();
    const initial = await (await call(ctx)).json() as { revision: number; currentStep: string };
    expect(initial).toMatchObject({ revision: 0, currentStep: "channels" });
    const moved = await call(ctx, "POST", { action: "step", currentStep: "models", expectedRevision: 0 });
    expect(await moved.json()).toMatchObject({ currentStep: "models", revision: 1, activatedAt: null });
    ctx.setNow(300);
    expect(await (await call(ctx, "POST", { action: "dismiss", currentStep: "models", expectedRevision: 1 })).json()).toMatchObject({ currentStep: "models", dismissedAt: 300 });
    expect(await (await call(ctx, "POST", { action: "resume", expectedRevision: 2 })).json()).toMatchObject({ currentStep: "models", dismissedAt: null });
    expect(ctx.sqlite.prepare("SELECT current_step FROM user_onboarding_progress WHERE user_id='auth-user-a'").get()).toEqual({ current_step: "models" });
  });

  it("isolates by immutable Better Auth id and activates only from both server evidence checks", async () => {
    const ctx = context();
    ctx.setEvidence(true, false);
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: null, evidence: { connectedProvider: true, successfulRun: false } });
    ctx.setNow(250);
    ctx.setEvidence(false, true);
    expect(await (await call(ctx)).json()).toMatchObject({ activatedAt: 250, evidence: { connectedProvider: false, successfulRun: true } });
    ctx.setIdentity({ userId: "auth-user-b", ownerEmail: "b@example.test" });
    expect(await (await call(ctx)).json()).toMatchObject({ currentStep: "channels", activatedAt: null });
    expect(ctx.sqlite.prepare("SELECT COUNT(*) AS count FROM user_onboarding_progress").get()).toEqual({ count: 2 });
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
    ctx.setEvidence(null, null);
    const response = await call(ctx, "POST", { action: "step", currentStep: "agent", expectedRevision: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currentStep: "agent", evidence: { connectedProvider: null, successfulRun: null } });
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
});
