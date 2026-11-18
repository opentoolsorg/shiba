import { describe, expect, it, vi } from "vitest";
import { signInternal, verifyInternal } from "../src/security/signing.js";
const env = { INTERNAL_SIGNING_KEY: "ab".repeat(32) };
const purpose = "shiba/test/v1";
describe("internal signing", () => {
  it("derives purpose-specific signatures with a key id", async () => {
    const signature = await signInternal(env, purpose, "message");
    expect(signature).toMatch(/^v1:[a-f0-9]{16}:[a-f0-9]{64}$/);
    expect(await verifyInternal(env, purpose, "message", signature)).toBe(true);
    expect(await verifyInternal(env, "shiba/other/v1", "message", signature)).toBe(false);
    expect(await verifyInternal(env, purpose, "tampered", signature)).toBe(false);
    expect(
      await verifyInternal(
        env,
        purpose,
        "message",
        signature.replace(/^v1:([a-f0-9])/, (_, byte: string) => `v1:${byte === "f" ? "e" : "f"}`),
      ),
    ).toBe(false);
    expect(
      await verifyInternal(
        { INTERNAL_SIGNING_KEY: "cd".repeat(32) },
        purpose,
        "message",
        signature,
      ),
    ).toBe(false);
  });
  it("accepts the old raw HMAC only during the enabled grace window", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.INTERNAL_SIGNING_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("message")),
    );
    const legacy = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await verifyInternal(env, purpose, "message", legacy)).toBe(false);
    expect(await verifyInternal(env, purpose, "message", legacy, env.INTERNAL_SIGNING_KEY)).toBe(
      true,
    );
    expect(
      await verifyInternal(
        { ...env, SHIBA_LEGACY_SIGNING_FALLBACK: "1" },
        purpose,
        "message",
        legacy,
        env.INTERNAL_SIGNING_KEY,
      ),
    ).toBe(true);
    expect(
      await verifyInternal(
        { ...env, SHIBA_LEGACY_SIGNING_FALLBACK: "0" },
        purpose,
        "message",
        legacy,
        env.INTERNAL_SIGNING_KEY,
      ),
    ).toBe(false);
    expect(await verifyInternal(env, purpose, "changed", legacy, env.INTERNAL_SIGNING_KEY)).toBe(
      false,
    );
    expect(await verifyInternal({}, purpose, "message", legacy)).toBe(false);
  });
  it("requires explicit legacy signing opt-in", async () => {
    await expect(
      signInternal({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) }, purpose, "message"),
    ).rejects.toThrow("INTERNAL_SIGNING_KEY not set");
  });
  it("signs and verifies with only the legacy model key during grace", async () => {
    const legacyEnv = { MODEL_CREDENTIAL_KEY: "ab".repeat(32), SHIBA_LEGACY_SIGNING_FALLBACK: "1" };
    const signature = await signInternal(
      legacyEnv,
      purpose,
      "message",
      legacyEnv.MODEL_CREDENTIAL_KEY,
    );
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await verifyInternal(
        legacyEnv,
        purpose,
        "message",
        signature,
        legacyEnv.MODEL_CREDENTIAL_KEY,
      ),
    ).toBe(true);
    await expect(
      signInternal(
        { ...legacyEnv, SHIBA_LEGACY_SIGNING_FALLBACK: "0" },
        purpose,
        "message",
        legacyEnv.MODEL_CREDENTIAL_KEY,
      ),
    ).rejects.toThrow("INTERNAL_SIGNING_KEY not set");
    expect(
      await verifyInternal(
        { ...legacyEnv, SHIBA_LEGACY_SIGNING_FALLBACK: "0" },
        purpose,
        "message",
        signature,
        legacyEnv.MODEL_CREDENTIAL_KEY,
      ),
    ).toBe(false);
  });
  it("refuses short signing keys even when a legacy key is offered", async () => {
    await expect(
      signInternal({ INTERNAL_SIGNING_KEY: "short" }, purpose, "message", env.INTERNAL_SIGNING_KEY),
    ).rejects.toThrow("at least 32");
  });
  it("prefers purpose-bound signing when the new key is configured", async () => {
    expect(await signInternal(env, purpose, "message", "old-key")).toMatch(/^v1:/);
  });
  it("warns once per module instance without logging keys", async () => {
    vi.resetModules();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const signing = await import("../src/security/signing.js");
      const legacyEnv = { SHIBA_LEGACY_SIGNING_FALLBACK: "1" };
      await signing.signInternal(legacyEnv, purpose, "message", env.INTERNAL_SIGNING_KEY);
      await signing.signInternal(legacyEnv, purpose, "message", env.INTERNAL_SIGNING_KEY);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.join(" ")).toContain("SHIBA_LEGACY_SIGNING_FALLBACK=0");
      expect(warning.mock.calls[0]?.join(" ")).not.toContain(env.INTERNAL_SIGNING_KEY);
    } finally {
      warning.mockRestore();
    }
  });
});
