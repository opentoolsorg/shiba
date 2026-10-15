import { describe, expect, it, vi } from "vitest";
import {
  createToken,
  hashToken,
  hasScope,
  listTokens,
  requireScope,
  ScopeError,
  SCOPES,
  TOKEN_PREFIX,
  verifyToken,
  revokeToken,
  type AgentTokensEnv,
  type TokenRecord,
} from "../src/agent-tokens.js";
import { InputError } from "../src/security.js";

/**
 * Pure-boundary harness: the store's only seam is `env.AGENT_TOKENS`, faked
 * here by an in-memory KV. The real binding speaks JSON over the wire; the
 * fake stores the same JSON strings so parse paths stay honest.
 */
class FakeKV {
  readonly map = new Map<string, string>();
  readonly metadata = new Map<string, unknown>();
  /**
   * Keys per list() page — small by default so every listing test walks
   * the cursor loop the way real KV does (opaque cursor = next offset).
   */
  pageSize = 2;
  listCalls = 0;
  getCalls = 0;
  putCalls = 0;
  failOnListCall = 0;

  async get(key: string, opts?: { type?: string }): Promise<unknown> {
    this.getCalls += 1;
    const value = this.map.get(key);
    if (value === undefined) {
      return null;
    }
    return opts?.type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void> {
    this.putCalls += 1;
    this.map.set(key, value);
    if (opts && "metadata" in opts) {
      this.metadata.set(key, opts.metadata);
    } else {
      this.metadata.delete(key);
    }
  }

  async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
    this.listCalls += 1;
    if (this.failOnListCall === this.listCalls) {
      throw new Error("kv list page failed");
    }
    const names = [...this.map.keys()]
      .filter((name) => name.startsWith(opts?.prefix ?? ""))
      .sort();
    const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const limit = opts?.limit ?? this.pageSize;
    const keys = names
      .slice(start, start + limit)
      .map((name) => ({ name, metadata: this.metadata.get(name) }));
    const complete = start + limit >= names.length;
    return {
      keys,
      list_complete: complete,
      cursor: complete ? "" : String(start + limit),
      cacheStatus: null,
    };
  }
}

function makeEnv(): AgentTokensEnv & { kv: FakeKV } {
  const kv = new FakeKV();
  return { AGENT_TOKENS: kv as unknown as KVNamespace, kv };
}

const WELL_FORMED_UNKNOWN = `shb_${"0".repeat(16)}_${"0".repeat(48)}`;

describe("hashToken", () => {
  it("is deterministic 64-char sha256 hex, distinct per input", async () => {
    const hash = await hashToken("shb_some_token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("shb_some_token")).toBe(hash);
    expect(await hashToken("shb_other_token")).not.toBe(hash);
  });
});

describe("createToken", () => {
  it("mints a shb_<id>_<secret> token and stores the record hashed", async () => {
    const env = makeEnv();
    const { token, record } = await createToken(env, "scout", ["email:read", "email:draft"]);
    expect(token).toMatch(/^shb_[0-9a-f]{16}_[0-9a-f]{48}$/);
    expect(record).toMatchObject({
      principal: "scout",
      scopes: ["email:read", "email:draft"],
      revoked: false,
    });
    expect(typeof record.created).toBe("number");
    // The record lands under tok_<sha256(token)> — and the raw token never
    // appears in a key or value, so a KV dump cannot mint a bearer.
    expect(env.kv.map.size).toBe(1);
    const [key, value] = [...env.kv.map.entries()][0]!;
    expect(key.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(key.slice(TOKEN_PREFIX.length)).toBe(await hashToken(token));
    expect(value).not.toContain(token);
    expect(env.kv.metadata.get(key)).toEqual(record);
    expect(JSON.stringify(env.kv.metadata.get(key))).not.toContain(token);
    expect(JSON.stringify(env.kv.metadata.get(key))).not.toContain(
      key.slice(TOKEN_PREFIX.length),
    );
  });

  it("dedupes scopes and validates them against SCOPES", async () => {
    const env = makeEnv();
    const { record } = await createToken(env, "writer", ["memory:read", "memory:read"]);
    expect(record.scopes).toEqual(["memory:read"]);
    await expect(createToken(env, "bad", ["email:fly"])).rejects.toThrow(InputError);
    await expect(createToken(env, "bad", ["email:read", "nope"])).rejects.toThrow(
      /unknown scope "nope"/,
    );
  });

  it("rejects a scopeless token and a blank/whitespace principal", async () => {
    const env = makeEnv();
    await expect(createToken(env, "nobody", [])).rejects.toThrow(InputError);
    await expect(createToken(env, "   ", ["email:read"])).rejects.toThrow(InputError);
    await expect(createToken(env, "two words", ["email:read"])).rejects.toThrow(/whitespace/);
    expect(env.kv.map.size).toBe(0);
  });
});

describe("verifyToken", () => {
  it("round-trips a created token to its record", async () => {
    const env = makeEnv();
    const { token, record } = await createToken(env, "engage", SCOPES.slice(0, 3));
    expect(await verifyToken(env, token)).toEqual(record);
  });

  it("answers null for unknown, malformed, and non-token strings", async () => {
    const env = makeEnv();
    await createToken(env, "scout", ["email:read"]);
    expect(await verifyToken(env, WELL_FORMED_UNKNOWN)).toBeNull();
    expect(await verifyToken(env, "shb_nothex")).toBeNull();
    expect(await verifyToken(env, "Bearer abc")).toBeNull();
    expect(await verifyToken(env, "")).toBeNull();
  });

  it("answers null after revocation without naming the cause", async () => {
    const env = makeEnv();
    const { token } = await createToken(env, "scout", ["email:read"]);
    expect(await verifyToken(env, token)).not.toBeNull();
    await revokeToken(env, token);
    expect(await verifyToken(env, token)).toBeNull();
  });
});

describe("revokeToken", () => {
  it("flips revoked on the stored record, idempotently", async () => {
    const env = makeEnv();
    const { token } = await createToken(env, "scout", ["email:read"]);
    const revoked = await revokeToken(env, token);
    expect(revoked?.principal).toBe("scout");
    expect(revoked?.revoked).toBe(true);
    const key = TOKEN_PREFIX + (await hashToken(token));
    expect(env.kv.metadata.get(key)).toEqual(revoked);
    // A second revoke is a no-op returning the same record — no KV write,
    // no error, and the entry still counts in listTokens.
    const writesAfterFirstRevoke = env.kv.putCalls;
    expect(await revokeToken(env, token)).toEqual(revoked);
    expect(env.kv.putCalls).toBe(writesAfterFirstRevoke);
    expect(env.kv.map.size).toBe(1);
  });

  it("answers null for unknown or malformed tokens", async () => {
    const env = makeEnv();
    expect(await revokeToken(env, WELL_FORMED_UNKNOWN)).toBeNull();
    expect(await revokeToken(env, "garbage")).toBeNull();
  });

  it("returns null when the revoke write fails, without claiming revocation", async () => {
    const env = makeEnv();
    const { token } = await createToken(env, "scout", ["email:read"]);
    const key = TOKEN_PREFIX + (await hashToken(token));
    env.kv.put = async () => {
      throw new Error("kv write unavailable");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await revokeToken(env, token)).toBeNull();
    expect(JSON.parse(env.kv.map.get(key)!)).toMatchObject({ revoked: false });
    warn.mockRestore();
  });
});

describe("scopes", () => {
  const record: TokenRecord = {
    principal: "analyst",
    scopes: ["memory:read", "email:read"],
    created: 1,
    revoked: false,
  };

  it("hasScope reflects the grant list", () => {
    expect(hasScope(record, "email:read")).toBe(true);
    expect(hasScope(record, "email:send")).toBe(false);
    expect(hasScope(null, "email:read")).toBe(false);
  });

  it("requireScope passes a granted scope and throws ScopeError otherwise", () => {
    expect(() => requireScope(record, "memory:read")).not.toThrow();
    expect(() => requireScope(record, "email:send")).toThrow(ScopeError);
    try {
      requireScope(record, "admin:tokens");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as ScopeError).scope).toBe("admin:tokens");
      expect((error as Error).message).toContain("analyst");
    }
    // A null record fails closed the same way a missing scope does.
    expect(() => requireScope(null, "email:read")).toThrow(ScopeError);
  });
});

describe("listTokens", () => {
  it("lists every record oldest-first, revoked included", async () => {
    const env = makeEnv();
    const a = await createToken(env, "a-agent", ["email:read"], 100);
    const b = await createToken(env, "b-agent", ["sandbox:exec"], 200);
    await revokeToken(env, b.token);
    const records = await listTokens(env);
    expect(records.map((r) => r.principal)).toEqual(["a-agent", "b-agent"]);
    expect(records[1]?.revoked).toBe(true);
    // Tokens from other tenants of the namespace never leak in.
    env.kv.map.set("unrelated_key", '"not a record"');
    env.kv.map.set(`${TOKEN_PREFIX}corrupt`, "{bad json");
    expect(await listTokens(env)).toHaveLength(2);
    void a;
  });

  it("follows the cursor across multiple pages", async () => {
    const env = makeEnv();
    env.kv.pageSize = 2;
    for (let i = 0; i < 5; i += 1) {
      await createToken(env, `p${i}-agent`, ["email:read"], 100 + i);
    }
    const records = await listTokens(env);
    // 5 keys / 2 per page = 3 fetches; every record still lands, sorted.
    expect(env.kv.listCalls).toBe(3);
    expect(records.map((r) => r.principal)).toEqual([
      "p0-agent",
      "p1-agent",
      "p2-agent",
      "p3-agent",
      "p4-agent",
    ]);
  });

  it("uses key metadata without value reads and never exposes extra metadata fields", async () => {
    const env = makeEnv();
    await createToken(env, "meta-agent", ["email:read"], 100);
    const [key = ""] = [...env.kv.map.keys()];
    env.kv.metadata.set(key, {
      principal: "meta-agent",
      scopes: ["email:read"],
      created: 100,
      revoked: false,
      bearer: "shb_must_not_leak",
      tokenHash: "hash_must_not_leak",
    });
    env.kv.getCalls = 0;
    const records = await listTokens(env);
    expect(env.kv.getCalls).toBe(0);
    expect(records).toEqual([
      { principal: "meta-agent", scopes: ["email:read"], created: 100, revoked: false },
    ]);
    expect(JSON.stringify(records)).not.toContain("must_not_leak");
  });

  it("falls back to value reads only for legacy or malformed metadata", async () => {
    const env = makeEnv();
    env.kv.pageSize = 10;
    const legacyValue = JSON.stringify({
      principal: "legacy-agent",
      scopes: ["runs:read"],
      created: 90,
      revoked: true,
    });
    const malformedValue = JSON.stringify({
      principal: "malformed-agent",
      scopes: ["memory:read"],
      created: 80,
      revoked: false,
    });
    env.kv.map.set(TOKEN_PREFIX + "legacy", legacyValue);
    env.kv.map.set(TOKEN_PREFIX + "malformed", malformedValue);
    env.kv.metadata.set(TOKEN_PREFIX + "malformed", { principal: 42, extra: true });
    await createToken(env, "new-agent", ["email:send"], 100);

    env.kv.getCalls = 0;
    const records = await listTokens(env);
    expect(env.kv.getCalls).toBe(2);
    expect(records.map((r) => r.principal)).toEqual([
      "malformed-agent",
      "legacy-agent",
      "new-agent",
    ]);
    expect(records[1]?.revoked).toBe(true);
  });

  it("keeps verification value-backed when listing metadata is stale", async () => {
    const env = makeEnv();
    const { token } = await createToken(env, "scout", ["email:read"]);
    await revokeToken(env, token);
    const key = TOKEN_PREFIX + (await hashToken(token));
    env.kv.metadata.set(key, {
      principal: "scout",
      scopes: ["email:read"],
      created: 1,
      revoked: false,
    });
    expect(await verifyToken(env, token)).toBeNull();
  });

  it("returns records already collected when a later page fails", async () => {
    const env = makeEnv();
    env.kv.pageSize = 2;
    for (let i = 0; i < 5; i += 1) {
      await createToken(env, "p" + i + "-agent", ["email:read"], 100 + i);
    }
    env.kv.failOnListCall = 3;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = await listTokens(env);
    // Keys are token hashes, so which record sat on the failed page is random.
    const created = records.map((r) => r.created);
    expect(created).toHaveLength(4);
    expect(created).toEqual([...created].sort((a, b) => a - b));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns an empty list on a fresh namespace", async () => {
    const env = makeEnv();
    expect(await listTokens(env)).toEqual([]);
  });

  it("denies cleanly when KV is down instead of throwing", async () => {
    const env = makeEnv();
    const { token } = await createToken(env, "scout", ["email:read"]);
    const down = {
      AGENT_TOKENS: {
        get: async () => {
          throw new Error("kv unavailable");
        },
        put: async () => {
          throw new Error("kv unavailable");
        },
        list: async () => {
          throw new Error("kv unavailable");
        },
      } as unknown as KVNamespace,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verifyToken(down, token)).toBeNull();
    expect(await revokeToken(down, token)).toBeNull();
    expect(await listTokens(down)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
