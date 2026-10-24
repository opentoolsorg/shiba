/**
 * Tradeoff contracts named in AGENTS.md. Each test is the automated check
 * for one sentence in that file.
 */
import { describe, expect, it } from "vitest";
import { denyUnscopedGitHub, forwardGitHubScoped, type EgressEnv } from "../src/egress.js";
import { codexSubscriptionHarness } from "../src/harness/codex-subscription.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const run = (extra: Partial<CodingTaskInput> = {}): CodingTaskInput => ({
  repoUrl: "https://github.com/acme/widgets",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "openai-subscription/gpt-5.3-codex",
  ...extra,
});

describe("AGENTS.md tradeoff contracts", () => {
  it("credentials never enter the container", () => {
    const secret = "chatgpt-access-token-value";
    const input = run({ initiatorUserId: "ada", chatgptAccessToken: secret });
    const env = codexSubscriptionHarness.env(input, null);
    const files = codexSubscriptionHarness.configFile(input, input.sandboxId);
    const argv = codexSubscriptionHarness.buildArgv(input, "/workspace");
    const blob = JSON.stringify({ env, files, argv });
    expect(blob).not.toContain(secret);
    expect(env.ACCESS_TOKEN).toBe("shiba-egress-placeholder");
    expect(codexSubscriptionHarness.egressOverrides(input)[0]).toMatchObject({
      handler: "codexPlan",
      params: { userId: "ada" },
    });
  });

  it("refuses GitHub traffic until a repo scope is approved, and then only that repo", async () => {
    const denied = await denyUnscopedGitHub();
    expect(denied.status).toBe(403);
    const outside = await forwardGitHubScoped(
      new Request("https://github.com/other/repo/git-upload-pack", { method: "POST" }),
      {} as EgressEnv,
      { params: { allowedPath: "/acme/widgets" } },
    );
    expect(outside.status).toBe(403);
    expect(await outside.text()).toMatch(/approved scope/);
  });
});
