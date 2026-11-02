import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSetupSteps, OPERATOR_STEPS } from "./OnboardingModal";

afterEach(() => vi.unstubAllGlobals());

function setupStatus(status: unknown, keysConfigured = false): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/setup/status") return Response.json(status);
    if (String(input) === "/api/org/model-keys") return Response.json({ keys: [{ configured: keysConfigured }] });
    return Response.json({});
  }));
}

describe("setup checklist evidence", () => {
  it("does not infer paid billing or authorized inference from a reachable status endpoint", async () => {
    setupStatus({ gateway: { reachable: "yes", token: false } }, true);
    const steps = await detectSetupSteps();
    expect(steps.has("workers-paid")).toBe(false);
    expect(steps.has("connect-model")).toBe(false);
  });

  it.each([
    { gateway: { reachable: "yes", token: true } },
    { gateway: { reachable: "not-configured", token: false }, doctor: { roles: [{ ok: true }, { ok: true }] } },
  ])("recognizes a configured gateway or ready subscription role routes", async (status) => {
    setupStatus(status);
    expect((await detectSetupSteps()).has("connect-model")).toBe(true);
  });

  it.each([
    { gateway: { reachable: "no", token: true } },
    { doctor: { roles: [] } },
    { doctor: { roles: [{ ok: true }, { ok: false }] } },
    { gateway: { reachable: "yes", token: true }, doctor: { roles: [{ ok: true }, { ok: false }] } },
    { doctor: { roles: [{}] } },
  ])("leaves unavailable or incomplete model routes unchecked", async (status) => {
    setupStatus(status);
    expect((await detectSetupSteps()).has("connect-model")).toBe(false);
  });

  it.each([false, true])("requires channel repository mapping for Slack setup (mapping=%s)", async (channelRepos) => {
    setupStatus({ slack: { signingSecret: true, botToken: true, approvers: 1, channelRepos } });
    expect((await detectSetupSteps()).has("slack-bot")).toBe(channelRepos);
    expect(OPERATOR_STEPS.find((step) => step.id === "slack-bot")?.codeSnippet).toContain("SLACK_CHANNEL_REPOS");
  });
});
