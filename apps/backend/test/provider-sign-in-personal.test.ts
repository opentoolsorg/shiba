import { describe, expect, it } from "vitest";
import { connectedDefaultForUser } from "../src/acp-providers.js";
import { resolveCodexSubscriptionAuthJson } from "../src/codex-subscription-credential.js";
import type { Env } from "../src/env.js";
import { beginProviderSignIn, completeProviderSignIn, inspectProviderSignIn } from "../src/provider-sign-in.js";
import { putUserProviderSecret } from "../src/user-provider-keys.js";

function storage(): Env {
  const records = new Map<string, string>();
  return {
    MODEL_CREDENTIAL_KEY: "ab".repeat(32),
    AGENT_TOKENS: {
      get: async (key: string) => records.get(key) ?? null,
      put: async (key: string, value: string) => { records.set(key, value); },
      delete: async (key: string) => { records.delete(key); },
    },
  } as unknown as Env;
}

const context = { mode: "oauth" as const, origin: "http://localhost", now: 0 };

describe("personal subscription sign-in", () => {
  it("does not select a paired computer as the automatic sandbox provider", async () => {
    const env = storage();
    await env.AGENT_TOKENS.put("acp_provider:alice:claude", JSON.stringify({
      phase: "connected", authMode: "oauth", signInKind: "claude-daemon", updatedAt: Date.now(),
    }));
    await env.AGENT_TOKENS.put("acp_provider_default:alice", "claude");
    expect(await connectedDefaultForUser(env, "alice")).toBeNull();
  });

  it("does not substitute an operator Codex credential when personal storage is unavailable", async () => {
    const env = { SHIBA_SINGLE_USER: "1", CODEX_SUBSCRIPTION_AUTH_JSON: crypto.randomUUID() } as Env;
    expect(await resolveCodexSubscriptionAuthJson(env, { userId: "alice" })).toBeNull();
  });
  it("recognizes an encrypted Claude setup-token only for its owner", async () => {
    const env = storage();
    await putUserProviderSecret(env, "alice", "claude-setup", crypto.randomUUID());
    const provider = { id: "claude", label: "Claude" };
    expect((await inspectProviderSignIn(env, provider, "alice")).ok).toBe(true);
    expect((await inspectProviderSignIn(env, provider, "bob")).ok).toBe(false);
  });

  it.each([
    ["claude", "SHIBA_CLAUDE_SUBSCRIPTION"],
    ["codex", "SHIBA_CODEX_SUBSCRIPTION"],
    ["gemini", "SHIBA_ANTIGRAVITY_SUBSCRIPTION"],
    ["cursor", "SHIBA_CURSOR_SUBSCRIPTION"],
  ])("refuses every sign-in operation for disabled %s", async (id, flag) => {
    const env = { ...storage(), [flag]: "0" } as Env;
    const provider = { id, label: id };
    for (const verdict of [
      await beginProviderSignIn(env, provider, "alice", context),
      await completeProviderSignIn(env, provider, "alice", null, crypto.randomUUID()),
      await inspectProviderSignIn(env, provider, "alice"),
    ]) {
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toMatch(/disabled/);
    }
  });

  it("allows Claude setup-token sign-in without an operator opt-in flag", async () => {
    const env = storage();
    const provider = { id: "claude", label: "Claude" };
    expect((await beginProviderSignIn(env, provider, "alice", context)).pending).toBe(true);
    expect((await completeProviderSignIn(env, provider, "alice", null, crypto.randomUUID())).ok).toBe(true);
    expect((await inspectProviderSignIn(env, provider, "alice")).ok).toBe(true);
  });
});
