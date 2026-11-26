import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_MASCOT_PRESETS, CUSTOM_AGENT_ROLE_TEMPLATE_IDS } from "@shiba/shared";
import { decodeCreateCustomAgent, decodeUpdateCustomAgent } from "../src/custom-agents-schema.js";

const config = { name: "My employee", instructions: "Prepare an editable draft from approved context.", harness: "opencode" };

describe("optional employee role provenance", () => {
  it.each(CUSTOM_AGENT_ROLE_TEMPLATE_IDS)("accepts explicit %s provenance without adding capabilities", (roleTemplateId) => {
    const input = { slug: "renamed-helper", config: { ...config, roleTemplateId } };
    expect(decodeCreateCustomAgent(input)).toEqual(input);
    expect(decodeUpdateCustomAgent({ config: input.config, expectedVersion: 1 })).toEqual({ config: input.config, expectedVersion: 1 });
    expect(input.config).not.toHaveProperty("connectionId");
    expect(input.config).not.toHaveProperty("toolScopes");
  });

  it.each(CUSTOM_AGENT_MASCOT_PRESETS)("accepts allowlisted mascot %s", (mascotPreset) => {
    const input = { slug: "helper", config: { ...config, mascotPreset } };
    expect(decodeCreateCustomAgent(input)).toEqual(input);
    expect(decodeUpdateCustomAgent({ config: input.config })).toEqual({ config: input.config });
  });

  it("accepts a complete visor look and rejects a partial or unsafe one", () => {
    const look = { shape: "pointed", color: "#c4a574", eyes: "happy", acc: "wrench" };
    expect(decodeCreateCustomAgent({ slug: "helper", config: { ...config, look } })).toEqual({ slug: "helper", config: { ...config, look } });
    expect(decodeCreateCustomAgent({ slug: "helper", config: { ...config, look: { ...look, color: "red" } } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, look: { shape: "round" } } })).toBeNull();
  });

  it.each(["https://example.test/avatar.png", "../hero", "", null, ["hero"], { id: "hero" }])("rejects unsafe mascot %j", (mascotPreset) => {
    expect(decodeCreateCustomAgent({ slug: "helper", config: { ...config, mascotPreset } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, mascotPreset } })).toBeNull();
  });

  it("keeps legacy custom profiles optional rather than inferring a role", () => {
    expect(decodeCreateCustomAgent({ slug: "finance-bot", config })).toEqual({ slug: "finance-bot", config });
  });

  it.each(["administrator", "Finance", "", null, ["finance"], { id: "hr" }])("rejects malformed provenance %j before persistence", (roleTemplateId) => {
    expect(decodeCreateCustomAgent({ slug: "helper", config: { ...config, roleTemplateId } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, roleTemplateId }, expectedVersion: 1 })).toBeNull();
  });
});

describe("employee manager identity", () => {
  it("accepts a user ID up to the workspace email limit", () => {
    const userId = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    const input = { slug: "helper", config: { ...config, reportsTo: { kind: "user", userId } } };
    expect(decodeCreateCustomAgent(input)).toEqual(input);
    expect(decodeUpdateCustomAgent({ config: input.config })).toEqual({ config: input.config });
    expect(decodeUpdateCustomAgent({ config: { ...config, reportsTo: { kind: "user", userId: `a${userId}` } } })).toBeNull();
  });
});

describe("bot library links", () => {
  const id = (suffix: string) => `file_${suffix.padEnd(16, "0")}`;

  it("persists knowledge file ids so a bot's Library survives the config round trip", () => {
    const libraryFileIds = [id("a"), id("b")];
    expect(decodeUpdateCustomAgent({ config: { ...config, libraryFileIds }, expectedVersion: 2 }))
      .toEqual({ config: { ...config, libraryFileIds }, expectedVersion: 2 });
  });

  it("drops the field when a bot has no linked files", () => {
    expect(decodeUpdateCustomAgent({ config, expectedVersion: 1 })).toEqual({ config, expectedVersion: 1 });
  });

  it.each([
    ["a path instead of an id", ["../etc/passwd"]],
    ["a URL", ["https://example.test/secret.pdf"]],
    ["an empty id", [""]],
    ["a duplicate", [id("a"), id("a")]],
    ["more than the cap", Array.from({ length: 9 }, (_, index) => `file_${String(index).padEnd(16, "0")}`)],
    ["a bare string", id("a")],
  ])("rejects %s", (_label, libraryFileIds) => {
    expect(decodeUpdateCustomAgent({ config: { ...config, libraryFileIds }, expectedVersion: 1 })).toBeNull();
  });
});
