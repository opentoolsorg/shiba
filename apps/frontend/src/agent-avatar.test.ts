import { describe, expect, it } from "vitest";
import { AGENT_AVATAR_COATS, AGENT_AVATAR_VARIANTS, normalizeAgentAvatar, avatarLook, shuffledAvatar } from "@shiba/shared";

describe("bot avatar choices", () => {
  it("accepts a gallery variant at a brand coat", () => {
    const choice = { kind: "variant" as const, variant: AGENT_AVATAR_VARIANTS[0]!.id, color: AGENT_AVATAR_COATS[0]! };
    expect(normalizeAgentAvatar(choice)).toEqual(choice);
    expect(avatarLook(choice)).toMatchObject({ color: AGENT_AVATAR_COATS[0] });
  });

  it("refuses a variant or coat that is not on the allowed lists instead of coercing it", () => {
    expect(normalizeAgentAvatar({ kind: "variant", variant: "not-a-variant", color: "#c4a574" })).toBeUndefined();
    expect(normalizeAgentAvatar({ kind: "variant", variant: AGENT_AVATAR_VARIANTS[0]!.id, color: "#123456" })).toBeUndefined();
    expect(normalizeAgentAvatar({ kind: "variant", variant: AGENT_AVATAR_VARIANTS[0]!.id })).toBeUndefined();
    expect(normalizeAgentAvatar({ variant: AGENT_AVATAR_VARIANTS[0]!.id, color: AGENT_AVATAR_COATS[1]! })).toBeUndefined();
  });

  it("refuses markup, paths and foreign shapes as an upload reference", () => {
    for (const fileId of ["https://example.test/a.png", "../a.png", "<svg onload=alert(1)>", "file_", "file_aaaa<script>", ""]) {
      expect(normalizeAgentAvatar({ kind: "upload", fileId })).toBeUndefined();
    }
    expect(normalizeAgentAvatar({ kind: "upload", fileId: "file_abc12345" })).toEqual({ kind: "upload", fileId: "file_abc12345" });
  });

  it("shuffles to a different variant and coat, and repeats for the same seed", () => {
    const current = { kind: "variant" as const, variant: AGENT_AVATAR_VARIANTS[0]!.id, color: AGENT_AVATAR_COATS[0]! };
    const once = shuffledAvatar("seed", current);
    expect(once).toEqual(shuffledAvatar("seed", current));
    expect(once).not.toEqual(current);
    expect(once.kind).toBe("variant");
  });

  it("draws every gallery variant from the shared construction", () => {
    expect(AGENT_AVATAR_VARIANTS.length).toBeGreaterThanOrEqual(18);
    expect(new Set(AGENT_AVATAR_VARIANTS.map((variant) => variant.id)).size).toBe(AGENT_AVATAR_VARIANTS.length);
    expect(new Set(AGENT_AVATAR_VARIANTS.map((variant) => `${variant.shape}|${variant.eyes}|${variant.acc}`)).size).toBe(AGENT_AVATAR_VARIANTS.length);
    expect(new Set(AGENT_AVATAR_COATS).size).toBe(12);
  });
});
