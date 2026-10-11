/**
 * F16: approval evidence binds input through stableHash — it must be
 * SHA-256 (64-hex, collision-resistant), not the previous 32-bit FNV-1a.
 * Vectors computed against node:crypto for the canonical stableJson forms.
 */
import { describe, expect, it } from "vitest";
import { runInputHash, stableHash } from "@shiba/shared";

describe("stableHash", () => {
  it("is SHA-256 over the canonical JSON form", () => {
    // stableJson("abc") === "\"abc\""; sha256 of that exact string.
    expect(stableHash("abc")).toBe(
      "6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25",
    );
    // stableJson({}) === "{}".
    expect(stableHash({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });

  it("produces a 64-hex digest (not an 8-hex fingerprint)", () => {
    expect(runInputHash({ repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false }))
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-insensitive for object keys and sensitive to content", () => {
    const a = stableHash({ x: 1, y: 2 });
    const b = stableHash({ y: 2, x: 1 });
    const c = stableHash({ x: 1, y: 3 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
