import { describe, expect, it } from "vitest";
import { agentMascot } from "./agent-mascots";
import { AGENT_TEMPLATES } from "@shiba/shared";

describe("agent mascots", () => {
  it("maps every catalog teammate to a bundled mascot", () => {
    for (const template of AGENT_TEMPLATES) expect(agentMascot(template.id)).toMatch(/^\/assets\/agents\/(agni|chanakya|kavi|mitra|shravan|ved|vishwa)\.png$/);
    expect(agentMascot("coding-coworker")).toBe("/assets/agents/agni.png");
    expect(agentMascot("pr-reviewer")).toBe("/assets/agents/ved.png");
  });
  it("uses role fit before a stable custom-id fallback", () => {
    expect(agentMascot("custom-123", "design")).toBe("/assets/agents/vishwa.png");
    expect(agentMascot("custom-123", "custom")).toBe(agentMascot("custom-123"));
    expect(agentMascot("renamed-slug", "custom", "custom-123")).toBe(agentMascot("custom-123"));
  });
});
