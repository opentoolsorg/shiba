import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleOrgModelKeys } from "../src/org-model-keys-routes.js";
import { handleOrgSandboxSettings } from "../src/org-sandbox-routes.js";

describe("org sandbox and model keys routes security", () => {
  const hexKey = "ab".repeat(32);

  class FakeD1 {
    private rows = new Map<string, Record<string, unknown>>();

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
              this.rows.set(`sandbox:${orgId}`, {
                org_id: orgId,
                provider_id: providerId,
                computesdk_backend: backend,
                runner_url: runnerUrl,
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
              const [orgId] = params;
              return (this.rows.get(`sandbox:${orgId}`) as T) ?? null;
            }
            return null;
          },
          all: async () => ({ success: true, results: Array.from(this.rows.values()), meta: {} }),
        }),
      };
    }
  }

  it("returns 401 for org model keys when Access is required and identity is missing", async () => {
    const d1 = new FakeD1();
    const env = {
      AGENT_AUDIT: d1 as unknown as D1Database,
      MODEL_CREDENTIAL_KEY: hexKey,
      REQUIRE_ACCESS: "1",
    } as unknown as Env;

    const res = await handleOrgModelKeys(
      new Request("https://app.example.com/api/org/model-keys", { method: "GET" }),
      env,
    );
    expect(res?.status).toBe(401);
  });

  it("returns 401 for org sandbox when Access is required and identity is missing", async () => {
    const d1 = new FakeD1();
    const env = {
      AGENT_AUDIT: d1 as unknown as D1Database,
      MODEL_CREDENTIAL_KEY: hexKey,
      REQUIRE_ACCESS: "1",
    } as unknown as Env;

    const res = await handleOrgSandboxSettings(
      new Request("https://app.example.com/api/org/sandbox", { method: "GET" }),
      env,
    );
    expect(res?.status).toBe(401);
  });

  it("never echoes secret values in model keys responses", async () => {
    const d1 = new FakeD1();
    const env = {
      AGENT_AUDIT: d1 as unknown as D1Database,
      MODEL_CREDENTIAL_KEY: hexKey,
      SHIBA_SINGLE_USER: "1",
    } as unknown as Env;

    const secretKey = "sk-super-secret-key-1234";

    // PUT key on loopback host
    const putReq = new Request("http://127.0.0.1/api/org/model-keys/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: secretKey }),
    });
    const putRes = await handleOrgModelKeys(putReq, env);
    expect(putRes?.status).toBe(200);
    const putJson = (await putRes?.json()) as Record<string, unknown>;
    const bodyStr = JSON.stringify(putJson);
    expect(bodyStr).not.toContain(secretKey);
    expect(bodyStr).not.toContain("super-secret");
    expect(putJson.key).toMatchObject({
      provider: "anthropic",
      configured: true,
      last4: "1234",
    });

    // GET key list on loopback host
    const getReq = new Request("http://127.0.0.1/api/org/model-keys", {
      method: "GET",
    });
    const getRes = await handleOrgModelKeys(getReq, env);
    expect(getRes?.status).toBe(200);
    const getJson = (await getRes?.json()) as Record<string, unknown>;
    const getStr = JSON.stringify(getJson);
    expect(getStr).not.toContain(secretKey);
    expect(getStr).not.toContain("super-secret");
  });

  it("never echoes secret token in sandbox settings responses", async () => {
    const d1 = new FakeD1();
    const env = {
      AGENT_AUDIT: d1 as unknown as D1Database,
      MODEL_CREDENTIAL_KEY: hexKey,
      SHIBA_SINGLE_USER: "1",
    } as unknown as Env;

    const runnerToken = "token-secret-runner-xyz-9876";

    // PATCH sandbox settings on loopback host
    const patchReq = new Request("http://127.0.0.1/api/org/sandbox", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "computesdk",
        computesdkBackend: "e2b",
        runnerUrl: "https://runner.example.com",
        runnerToken,
      }),
    });
    const patchRes = await handleOrgSandboxSettings(patchReq, env);
    expect(patchRes?.status).toBe(200);
    const patchJson = (await patchRes?.json()) as Record<string, unknown>;
    const patchStr = JSON.stringify(patchJson);
    expect(patchStr).not.toContain(runnerToken);
    expect(patchStr).not.toContain("xyz");
    expect(patchJson.settings).toMatchObject({
      runnerTokenMeta: {
        configured: true,
        last4: "9876",
      },
    });

    // GET sandbox settings on loopback host
    const getReq = new Request("http://127.0.0.1/api/org/sandbox", {
      method: "GET",
    });
    const getRes = await handleOrgSandboxSettings(getReq, env);
    expect(getRes?.status).toBe(200);
    const getJson = (await getRes?.json()) as Record<string, unknown>;
    const getStr = JSON.stringify(getJson);
    expect(getStr).not.toContain(runnerToken);
  });
});
