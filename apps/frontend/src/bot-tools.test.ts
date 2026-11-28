import { describe, expect, it } from "vitest";
import { botCapabilityState, botEnabledToolCount, botToolRows, defaultAgentToolRows, type BotToolPolicy } from "./bot-tools";

const policy = (overrides: Partial<BotToolPolicy> = {}): BotToolPolicy => ({
  employeeVersion: 1,
  toolScopes: [],
  grants: [],
  ...overrides,
});

describe("bot capability state", () => {
  it("is on only when the bot names the capability and a live grant backs it", () => {
    const granted = policy({
      toolScopes: ["mcp:shiba:gmail_read"],
      grants: [{ capabilityId: "mcp:shiba:gmail_read", resourceId: "inbox-1", lifecycle: "active" }],
    });
    expect(botCapabilityState("mcp:shiba:gmail_read", granted)).toBe("on");
  });

  it("is off when a grant exists but the bot version left it out", () => {
    const off = policy({ grants: [{ capabilityId: "mcp:shiba:gmail_read", resourceId: "inbox-1", lifecycle: "active" }] });
    expect(botCapabilityState("mcp:shiba:gmail_read", off)).toBe("off");
  });

  it("is ungranted when the bot names a capability the server would refuse", () => {
    const stale = policy({ toolScopes: ["mcp:shiba:queue_run"] });
    expect(botCapabilityState("mcp:shiba:queue_run", stale)).toBe("ungranted");
  });

  it("treats a revoked grant as ungranted even when the scope survives", () => {
    const revoked = policy({
      toolScopes: ["mcp:shiba:gmail_read"],
      grants: [{ capabilityId: "mcp:shiba:gmail_read", resourceId: "inbox-1", lifecycle: "revoked" }],
    });
    expect(botCapabilityState("mcp:shiba:gmail_read", revoked)).toBe("ungranted");
  });
});

describe("tool rows", () => {
  it("reports unknown rather than empty while the policy has not loaded", () => {
    const rows = botToolRows({ policy: null, policyError: null, webSearchReady: null });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.filter((item) => item.id === "integrations" || item.id === "mcp" || item.id === "runs")) {
      expect(row.state).toBe("unknown");
    }
    expect(botEnabledToolCount(rows)).toBe(0);
  });

  it("carries the load failure into each unknown row instead of claiming no grants", () => {
    const rows = botToolRows({ policy: null, policyError: "Tool grants are unavailable (503).", webSearchReady: null });
    expect(rows.find((row) => row.id === "integrations")?.detail).toBe("Tool grants are unavailable (503).");
  });

  it("counts only real per-bot capabilities as on", () => {
    const rows = botToolRows({
      policy: policy({
        toolScopes: ["mcp:shiba:run_status"],
        grants: [{ capabilityId: "mcp:shiba:run_status", resourceId: "run-1", lifecycle: "active" }],
      }),
      policyError: null,
      webSearchReady: true,
    });
    expect(botEnabledToolCount(rows)).toBe(1);
    expect(rows.find((row) => row.id === "runs")?.state).toBe("on");
    // Workspace-wide surfaces never inflate the per-bot count.
    expect(rows.find((row) => row.id === "files")?.state).toBe("workspace");
  });

  it("marks web search unavailable when the deployment has no key", () => {
    const rows = botToolRows({ policy: policy(), policyError: null, webSearchReady: false });
    expect(rows.find((row) => row.id === "web_search")?.state).toBe("unavailable");
  });

  it("keeps the primary group order, then Shiba's own run and email groups", () => {
    const ids = botToolRows({ policy: policy(), policyError: null, webSearchReady: true }).map((row) => row.id);
    expect(ids).toEqual(["integrations", "mcp", "web_search", "memory", "knowledge", "files", "notes", "skills", "runs", "email"]);
  });

  it("gives the default agent workspace surfaces only, never a bot's grants", () => {
    const ids = defaultAgentToolRows({ webSearchReady: true }).map((row) => row.id);
    expect(ids).not.toContain("integrations");
    expect(ids).not.toContain("mcp");
    expect(ids.every((id) => ["web_search", "memory", "knowledge", "files", "notes", "skills"].includes(id))).toBe(true);
  });
});
