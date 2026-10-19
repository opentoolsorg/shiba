import { describe, expect, it, vi } from "vitest";
import {
  createAutomation,
  isScheduleDue,
  matchAutomationEvent,
  matchLinearTrigger,
  recordTrigger,
} from "../src/automations.js";
import { isGitHubPublishConfigured, resolveInstallationId } from "../src/github-auth.js";
import { linearAutomationTask, parseLinearAgentSessionPayload, verifyLinearWebhook } from "../src/linear/webhook.js";
import { fireAutomation } from "../src/automation-runner.js";

const REPO = "https://github.com/owner/repo";

describe("multiple schedule triggers", () => {
  it("tracks per-trigger scheduleFiredAt so two crons are independent", () => {
    const base = createAutomation({
      id: "multi-cron",
      prompt: "work",
      repoUrl: REPO,
      triggers: [
        { kind: "schedule", cron: "0 3 * * *", timezone: "UTC" },
        { kind: "schedule", cron: "0 4 * * *", timezone: "UTC" },
      ],
    }).automation;
    const at3 = Date.UTC(2026, 8, 17, 3, 0, 30);
    expect(matchAutomationEvent(base, { kind: "schedule", nowMs: at3 })).not.toBeNull();
    const fired = recordTrigger(base, at3, "t0");
    const at4 = Date.UTC(2026, 8, 17, 4, 0, 30);
    expect(isScheduleDue("0 4 * * *", at4, fired.scheduleFiredAt?.t0)).toBe(true);
    expect(matchAutomationEvent(fired, { kind: "schedule", nowMs: at4 })).not.toBeNull();
  });

  it("evaluates cron in a non-UTC timezone", () => {
    const trigger = { kind: "schedule" as const, cron: "0 9 * * *", timezone: "Asia/Kolkata" };
    const automation = createAutomation({
      id: "tz",
      prompt: "x",
      repoUrl: REPO,
      triggers: [trigger],
    }).automation;
    // 09:00 IST = 03:30 UTC on the same calendar day (Oct 2026).
    const nowMs = Date.UTC(2026, 9, 19, 3, 30, 0);
    expect(matchAutomationEvent(automation, { kind: "schedule", nowMs })).not.toBeNull();
  });
});

describe("linear automation trigger", () => {
  it("matches delegated sessions by team key", () => {
    const trigger = { kind: "linear" as const, teams: ["ENG"], actions: ["created"] as ("created" | "prompted")[] };
    expect(matchLinearTrigger(trigger, { action: "created", teamKey: "ENG" })).toBe(true);
    expect(matchLinearTrigger(trigger, { action: "created", teamKey: "DES" })).toBe(false);
  });

  it("parses agent session payload into a task string", () => {
    const event = parseLinearAgentSessionPayload({
      action: "created",
      promptContext: "<issue>demo</issue>",
      agentSession: { id: "sess-1", issue: { identifier: "ENG-1", title: "Fix" } },
    });
    expect(event?.agentSession?.id).toBe("sess-1");
    expect(linearAutomationTask(event!)).toContain("ENG-1");
  });
});

describe("webhook batching task merge", () => {
  it("appends batched webhook bodies to the queued task", async () => {
    const automation = createAutomation({
      id: "wh",
      prompt: "Triage",
      repoUrl: REPO,
      triggers: [{ kind: "webhook" }],
    }).automation;
    const queued = vi.fn().mockResolvedValue({ approvalId: "a1" });
    const result = await fireAutomation(
      automation,
      { kind: "webhook", secret: automation.webhookSecret!, batchedBodies: ["one", "two"] },
      {
        ai: { run: async () => ({ response: "NO" }) },
        model: "m",
        globalEnabled: true,
        canPublishPullRequest: false,
        queueRun: queued,
      },
    );
    expect(result.fired).toBe(true);
    expect(queued.mock.calls[0]?.[0]?.task).toContain("Webhook payloads (2)");
  });
});

describe("github app env", () => {
  it("detects publish configuration from App env", () => {
    expect(
      isGitHubPublishConfigured({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
        GITHUB_APP_INSTALLATION_ID: "99",
      } as import("../src/env.js").Env),
    ).toBe(true);
    expect(resolveInstallationId({ GITHUB_APP_INSTALLATION_ID: "42" } as import("../src/env.js").Env, "acme/api")).toBe(42);
  });
});

describe("linear webhook signature", () => {
  it("verifies HMAC when secret matches", async () => {
    const body = '{"action":"created"}';
    const secret = "test-secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const sig = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    await expect(verifyLinearWebhook(body, sig, secret)).resolves.toBe(true);
  });
});
