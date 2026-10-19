import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  Container: class {},
  proxyToSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getContainer: vi.fn(),
}));
import { allowedHostsFor, resolveHarness } from "../src/harness/index.js";
import { codexSubscriptionHarness } from "../src/harness/codex-subscription.js";
import { assertHarnessAuthorized } from "../src/auth/index.js";
import {
  clearUserOpenAiAuthMode,
  readUserOpenAiAuthMode,
  setUserOpenAiAuthMode,
} from "../src/subscription-device-auth.js";
import type { Env } from "../src/env.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

function makeD1() {
  const rows = new Map<string, { mode: string; updated_at: number }>();
  return {
    batch: async () => {},
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO")) {
            rows.set(String(args[0]), { mode: String(args[1]), updated_at: Number(args[2]) });
          }
          if (sql.includes("DELETE FROM")) rows.delete(String(args[0]));
        },
        first: async () => {
          if (sql.includes("SELECT mode")) {
            const row = rows.get(String(args[0]));
            return row ? { mode: row.mode } : null;
          }
          return null;
        },
      }),
    }),
  };
}

const input: CodingTaskInput = {
  repoUrl: "https://github.com/acme/widgets",
  task: "Fix",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-1",
  codingModel: "openai-subscription/gpt-5.3-codex",
  initiatorUserId: "alice",
};

describe("device-auth mode storage", () => {
  it("round-trips per-user mode", async () => {
    const env = { AGENT_AUDIT: makeD1() as unknown as D1Database } as Env;
    await setUserOpenAiAuthMode(env, "alice", "device-auth");
    expect(await readUserOpenAiAuthMode(env, "alice")).toBe("device-auth");
    await clearUserOpenAiAuthMode(env, "alice");
    expect(await readUserOpenAiAuthMode(env, "alice")).toBeNull();
  });
});

describe("device-auth harness routing", () => {
  it("widens egress to chatgpt.com for device-auth runs", () => {
    const harness = resolveHarness("codex-subscription", { MODEL_CREDENTIAL_KEY: "a".repeat(64) } as Env);
    const hosts = allowedHostsFor(harness, input.codingModel, { ...input, codexAuthMode: "device-auth" });
    expect(hosts).toContain("chatgpt.com");
    expect(hosts).toContain("auth.openai.com");
    expect(codexSubscriptionHarness.env({ ...input, codexAuthMode: "device-auth" }, null).CODEX_HOME).toContain(
      "device-auth",
    );
  });

  it("assertHarnessAuthorized accepts device-auth without T47 secret", async () => {
    const env = {
      AGENT_AUDIT: makeD1() as unknown as D1Database,
      SHIBA_CODEX_DEVICE_AUTH: "1",
    } as Env;
    await setUserOpenAiAuthMode(env, "alice", "device-auth");
    const harness = resolveHarness("codex-subscription", { MODEL_CREDENTIAL_KEY: "a".repeat(64) } as Env);
    await expect(assertHarnessAuthorized(env, harness, input)).resolves.toBeUndefined();
  });
});
