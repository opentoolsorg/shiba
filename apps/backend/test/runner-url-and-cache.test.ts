import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { putOrgSecret } from "../src/org-secrets-store.js";
import {
  resetSandboxProviderCache,
  resolveSandboxProviderForSelection,
} from "../src/sandbox/provider.js";
import { isPrivateOrLoopbackHost, validateRunnerUrl } from "../src/security.js";

describe("runner url validation and SSRF", () => {
  it("rejects non-https URLs and invalid hosts", () => {
    expect(() => validateRunnerUrl("http://example.com")).toThrow();
    expect(() => validateRunnerUrl("https://localhost:8080")).toThrow();
    expect(() => validateRunnerUrl("https://127.0.0.1")).toThrow();
    expect(() => validateRunnerUrl("https://10.0.0.1")).toThrow();
    expect(() => validateRunnerUrl("https://192.168.1.1")).toThrow();
    expect(() => validateRunnerUrl("https://172.16.0.1")).toThrow();
    expect(() => validateRunnerUrl("https://169.254.169.254")).toThrow();
    expect(() => validateRunnerUrl("https://runner.internal")).toThrow();
    expect(() => validateRunnerUrl("https://runner.local")).toThrow();
  });

  it("accepts valid public https runner URLs", () => {
    expect(validateRunnerUrl("https://runner.my-org.com")).toBe("https://runner.my-org.com");
    expect(validateRunnerUrl("https://runner.my-org.com:8443/")).toBe(
      "https://runner.my-org.com:8443",
    );
  });

  it("checks private/loopback hosts correctly", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("runner.example.com")).toBe(false);
  });
});

describe("org sandbox provider cache invalidation", () => {
  it("uses orgId and updatedAt in cache key for rotation invalidation", async () => {
    resetSandboxProviderCache();
    const hexKey = "ab".repeat(32);

    let row = {
      org_id: "org_cache_test",
      provider_id: "computesdk",
      computesdk_backend: "e2b",
      runner_url: "https://runner.example.com",
      updated_at: 1000,
    };

    const secrets = new Map<string, Record<string, unknown>>();

    const d1 = {
      prepare: (sql: string) => ({
        run: async () => ({ success: true, results: [], meta: {} }),
        bind: (...params: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO org_secrets")) {
              const [orgId, kind, name, cipher, last4, updatedAt] = params;
              secrets.set(`${orgId}:${kind}:${name}`, {
                org_id: orgId,
                kind,
                name,
                cipher,
                last4,
                updated_at: updatedAt,
              });
            }
            return { success: true, results: [], meta: {} };
          },
          first: async <T>() => {
            if (sql.includes("org_sandbox_settings")) return row as unknown as T;
            if (sql.includes("org_secrets")) {
              const [orgId, kind, name] = params;
              return (secrets.get(`${orgId}:${kind}:${name}`) as T) ?? null;
            }
            return null;
          },
        }),
      }),
    } as unknown as D1Database;

    const env = {
      AGENT_AUDIT: d1,
      MODEL_CREDENTIAL_KEY: hexKey,
      SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS: "1",
    } as unknown as Env;

    // Put valid encrypted secret for runner_token
    await putOrgSecret(env, "org_cache_test", "sandbox", "runner_token", "secret-token-123");

    const p1 = await resolveSandboxProviderForSelection(env, { orgId: "org_cache_test" });
    const p2 = await resolveSandboxProviderForSelection(env, { orgId: "org_cache_test" });
    expect(p1).toBe(p2);

    // Bump updatedAt (as happens on token rotation)
    row = { ...row, updated_at: 2000 };
    const p3 = await resolveSandboxProviderForSelection(env, { orgId: "org_cache_test" });
    expect(p3).not.toBe(p1);
  });
});
