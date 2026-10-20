import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleOrgSandboxSettings } from "../src/org-sandbox-routes.js";
import {
  resetSandboxProviderCache,
  resolveSandboxProviderForSelection,
} from "../src/sandbox/provider.js";

const hexKey = "ab".repeat(32);

class FakeD1 {
  rows = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return {
      run: async () => ({ success: true, results: [], meta: {} }),
      bind: (...params: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO org_secrets")) {
            const [orgId, kind, name, cipher, last4, updatedAt] = params;
            this.rows.set(`secret:${orgId}:${kind}:${name}`, {
              org_id: orgId,
              kind,
              name,
              cipher,
              last4,
              updated_at: updatedAt,
            });
          } else if (sql.includes("INSERT INTO org_sandbox_settings")) {
            const [orgId, providerId, backend, runnerUrl, updatedAt] = params;
            const prev = this.rows.get(`sandbox:${orgId}`);
            this.rows.set(`sandbox:${orgId}`, {
              org_id: orgId,
              provider_id: providerId,
              computesdk_backend: backend ?? prev?.computesdk_backend ?? null,
              runner_url: runnerUrl ?? prev?.runner_url ?? null,
              updated_at: updatedAt,
            });
          }
          return { success: true, results: [], meta: {} };
        },
        first: async <T>() => {
          if (sql.includes("FROM org_secrets")) {
            const [orgId, kind, name] = params;
            return (this.rows.get(`secret:${orgId}:${kind}:${name}`) as T) ?? null;
          }
          if (sql.includes("FROM org_sandbox_settings")) {
            return (this.rows.get(`sandbox:${params[0]}`) as T) ?? null;
          }
          return null;
        },
      }),
    };
  }
}

function makeEnv(extra: Record<string, string> = {}): Env {
  return {
    AGENT_AUDIT: new FakeD1() as unknown as D1Database,
    MODEL_CREDENTIAL_KEY: hexKey,
    SHIBA_SINGLE_USER: "1",
    SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS: "1",
    ...extra,
  } as unknown as Env;
}

function patch(env: Env, body: Record<string, unknown>) {
  return handleOrgSandboxSettings(
    new Request("http://127.0.0.1/api/org/sandbox", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSandboxProviderCache();
});

describe("runner URL and token stay bound as a pair", () => {
  it("never sends the deployment runner token to an org-supplied URL", async () => {
    const env = makeEnv({ SHIBA_COMPUTESDK_RUNNER_TOKEN: "deployment-token" });
    const d1 = env.AGENT_AUDIT as unknown as FakeD1;
    d1.rows.set("sandbox:self-hosted", {
      org_id: "self-hosted",
      provider_id: "computesdk",
      computesdk_backend: "e2b",
      runner_url: "https://attacker.example.com",
      updated_at: 1,
    });
    await expect(resolveSandboxProviderForSelection(env, { orgId: "self-hosted" })).rejects.toThrow(
      /runner token/i,
    );
  });

  it("rejects a PATCH that changes runnerUrl without a new token", async () => {
    const env = makeEnv();
    const first = await patch(env, {
      providerId: "computesdk",
      computesdkBackend: "e2b",
      runnerUrl: "https://runner.example.com",
      runnerToken: "tok-1",
    });
    expect(first?.status).toBe(200);

    const moved = await patch(env, { providerId: "computesdk", runnerUrl: "https://evil.example.com" });
    expect(moved?.status).toBe(400);

    const same = await patch(env, { providerId: "computesdk", runnerUrl: "https://runner.example.com" });
    expect(same?.status).toBe(200);
  });

  it("does not call a new URL with the stored token on /test", async () => {
    const env = makeEnv();
    await patch(env, {
      providerId: "computesdk",
      runnerUrl: "https://runner.example.com",
      runnerToken: "tok-1",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await handleOrgSandboxSettings(
      new Request("http://127.0.0.1/api/org/sandbox/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerUrl: "https://evil.example.com" }),
      }),
      env,
    );
    expect(res?.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
