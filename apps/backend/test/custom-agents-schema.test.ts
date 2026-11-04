import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_ROLE_TEMPLATE_IDS } from "@shiba/shared";
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

  it("keeps legacy custom profiles optional rather than inferring a role", () => {
    expect(decodeCreateCustomAgent({ slug: "finance-bot", config })).toEqual({ slug: "finance-bot", config });
  });

  it.each(["administrator", "Finance", "", null, ["finance"], { id: "hr" }])("rejects malformed provenance %j before persistence", (roleTemplateId) => {
    expect(decodeCreateCustomAgent({ slug: "helper", config: { ...config, roleTemplateId } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, roleTemplateId }, expectedVersion: 1 })).toBeNull();
  });
});
