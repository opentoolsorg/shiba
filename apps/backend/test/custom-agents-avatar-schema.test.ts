import { describe, expect, it } from "vitest";
import { AGENT_AVATAR_COATS, AGENT_AVATAR_VARIANTS } from "@shiba/shared";
import { decodeCreateCustomAgent, decodeUpdateCustomAgent } from "../src/custom-agents-schema.js";

const config = { name: "Scout", instructions: "Read before changing code.", harness: "opencode" };
const variant = AGENT_AVATAR_VARIANTS[0]!;
const coat = AGENT_AVATAR_COATS[1]!;

describe("stored bot avatars", () => {
  it("accepts an allowed variant at an allowed coat, for create and update", () => {
    const avatar = { kind: "variant", variant: variant.id, color: coat };
    expect(decodeCreateCustomAgent({ slug: "scout", config: { ...config, avatar } })).toEqual({ slug: "scout", config: { ...config, avatar } });
    expect(decodeUpdateCustomAgent({ config: { ...config, avatar }, expectedVersion: 3 })).toEqual({ config: { ...config, avatar }, expectedVersion: 3 });
  });

  it("refuses an unknown variant or an off-palette coat", () => {
    expect(decodeCreateCustomAgent({ slug: "scout", config: { ...config, avatar: { kind: "variant", variant: "not-a-variant", color: coat } } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, avatar: { kind: "variant", variant: variant.id, color: "#123456" } } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, avatar: { kind: "variant", variant: variant.id } } })).toBeNull();
  });

  it("accepts an upload reference only as a stored file id", () => {
    const avatar = { kind: "upload", fileId: "file_abc12345" };
    expect(decodeCreateCustomAgent({ slug: "scout", config: { ...config, avatar } })).toEqual({ slug: "scout", config: { ...config, avatar } });
    for (const fileId of ["https://example.test/a.png", "../a.png", "file_aaaa<script>", "", null]) {
      expect(decodeCreateCustomAgent({ slug: "scout", config: { ...config, avatar: { kind: "upload", fileId } } })).toBeNull();
    }
  });

  it("refuses an avatar of an unknown kind and a legacy look left alongside it", () => {
    expect(decodeCreateCustomAgent({ slug: "scout", config: { ...config, avatar: { kind: "sticker", id: "hero" } } })).toBeNull();
    expect(decodeCreateCustomAgent({
      slug: "scout",
      config: { ...config, avatar: { kind: "variant", variant: variant.id, color: coat }, look: { shape: "javascript:alert(1)", color: coat, eyes: "happy", acc: "none" } },
    })).toBeNull();
  });
});
