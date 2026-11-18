// The shell cannot import @shiba/shared at runtime (Electron loads plain CJS
// and shared publishes TypeScript source), so it carries its own copy of the
// refusal sentences. This test is what keeps the two tables identical.
import { PAIR_FAILURE_MESSAGES } from "@shiba/shared";
import { describe, expect, it } from "vitest";
import { PAIR_FAILURE_COPY_TABLE, shellFailure } from "../src/pair-copy.js";

describe("shell refusal copy", () => {
  it("matches the shared table word for word", () => {
    for (const [code, copy] of Object.entries(PAIR_FAILURE_COPY_TABLE)) {
      expect(PAIR_FAILURE_MESSAGES[code as keyof typeof PAIR_FAILURE_MESSAGES]).toBe(copy);
    }
  });

  it("answers an old dashboard with the same sentence beside the code", () => {
    const result = shellFailure("pairing_deferred");
    expect(result).toEqual({
      ok: false,
      code: "pairing_deferred",
      error: PAIR_FAILURE_COPY_TABLE.pairing_deferred,
    });
  });

  it("never quotes a deployment URL or a secret in a refusal", () => {
    for (const copy of Object.values(PAIR_FAILURE_COPY_TABLE)) {
      // "Use https://" is instruction, not an address: strip the scheme words
      // and the one dev host, then no origin of any kind may remain.
      const rest = copy.replace(/https:\/\//gi, "").replace(/http:\/\/localhost/gi, "");
      expect(rest).not.toContain("://");
      expect(copy).not.toMatch(/token|bearer/i);
    }
  });
});
