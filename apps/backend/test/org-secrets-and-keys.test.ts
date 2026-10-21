import { describe, expect, it } from "vitest";
import {
  deleteOrgModelKey,
  getDecryptedOrgModelKey,
  getOrgModelKeyStatus,
  listOrgModelKeyStatuses,
  setOrgModelKey,
} from "../src/org-model-keys-store.js";
import {
  deleteOrgSecret,
  getDecryptedOrgSecret,
  getOrgSecretMeta,
  putOrgSecret,
} from "../src/org-secrets-store.js";

// In-memory fake D1 for secret tables
class FakeSecretsD1 {
  private rows = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return {
      run: async () => ({ success: true, results: [], meta: {} }),
      bind: (...params: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO org_secrets")) {
            const [orgId, kind, name, cipher, last4, updatedAt] = params;
            const key = `${orgId}:${kind}:${name}`;
            this.rows.set(key, { org_id: orgId, kind, name, cipher, last4, updated_at: updatedAt });
          } else if (sql.includes("DELETE FROM org_secrets")) {
            const [orgId, kind, name] = params;
            const key = `${orgId}:${kind}:${name}`;
            this.rows.delete(key);
          }
          return { success: true, results: [], meta: {} };
        },
        first: async <T = Record<string, unknown>>() => {
          if (sql.includes("FROM org_secrets")) {
            const [orgId, kind, name] = params;
            const key = `${orgId}:${kind}:${name}`;
            return (this.rows.get(key) as T) ?? null;
          }
          return null;
        },
        all: async () => ({ success: true, results: Array.from(this.rows.values()), meta: {} }),
      }),
    };
  }
}

describe("org secrets and model keys", () => {
  const hexKey = "ab".repeat(32);

  it("encrypts and decrypts secrets with write-only metadata", async () => {
    const d1 = new FakeSecretsD1() as unknown as D1Database;
    const env = { AGENT_AUDIT: d1, MODEL_CREDENTIAL_KEY: hexKey };

    const secret = "sk-ant-api03-abcdefghijklmn-1234";
    const putRes = await putOrgSecret(env, "org_1", "model_key", "anthropic", secret);
    expect(putRes.configured).toBe(true);
    expect(putRes.last4).toBe("1234");
    expect((putRes as unknown as Record<string, unknown>).secret).toBeUndefined();

    const meta = await getOrgSecretMeta(env, "org_1", "model_key", "anthropic");
    expect(meta.configured).toBe(true);
    expect(meta.last4).toBe("1234");
    expect((meta as unknown as Record<string, unknown>).cipher).toBeUndefined();

    const decrypted = await getDecryptedOrgSecret(env, "org_1", "model_key", "anthropic");
    expect(decrypted).toBe(secret);

    await deleteOrgSecret(env, "org_1", "model_key", "anthropic");
    const afterDelete = await getOrgSecretMeta(env, "org_1", "model_key", "anthropic");
    expect(afterDelete.configured).toBe(false);
  });

  it("manages org model keys for supported providers", async () => {
    const d1 = new FakeSecretsD1() as unknown as D1Database;
    const env = { AGENT_AUDIT: d1, MODEL_CREDENTIAL_KEY: hexKey };

    await setOrgModelKey(env, "org_2", "openai", "sk-proj-testkey9999");
    const status = await getOrgModelKeyStatus(env, "org_2", "openai");
    expect(status.configured).toBe(true);
    expect(status.last4).toBe("9999");
    expect(status.provider).toBe("openai");

    const all = await listOrgModelKeyStatuses(env, "org_2");
    expect(all).toHaveLength(4);
    const openaiKey = all.find((k) => k.provider === "openai");
    expect(openaiKey?.configured).toBe(true);
    const anthropicKey = all.find((k) => k.provider === "anthropic");
    expect(anthropicKey?.configured).toBe(false);

    const decrypted = await getDecryptedOrgModelKey(env, "org_2", "openai");
    expect(decrypted).toBe("sk-proj-testkey9999");

    await deleteOrgModelKey(env, "org_2", "openai");
    const deletedStatus = await getOrgModelKeyStatus(env, "org_2", "openai");
    expect(deletedStatus.configured).toBe(false);
  });
});
