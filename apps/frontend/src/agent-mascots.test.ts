import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { agentMascot } from "./agent-mascots";
import { AGENT_TEMPLATES, CUSTOM_AGENT_MASCOT_PRESETS } from "@shiba/shared";

describe("agent mascots", () => {
  it("maps every catalog teammate to a bundled Shiba sticker", () => {
    for (const template of AGENT_TEMPLATES) expect(agentMascot(template.id)).toMatch(/^\/assets\/mascot\/shiba-sticker-(hero|climbing|riding|sleeping|sunglasses)\.webp$/);
    expect(agentMascot("coding-coworker")).toBe("/assets/mascot/shiba-sticker-hero.webp");
    expect(agentMascot("pr-reviewer")).toBe("/assets/mascot/shiba-sticker-sunglasses.webp");
    expect(agentMascot("shiba")).toBe("/assets/mascot/shiba-sticker-hero.webp");
  });
  it("uses role fit before a stable custom-id fallback", () => {
    expect(agentMascot("custom-123", "design")).toBe("/assets/mascot/shiba-sticker-riding.webp");
    expect(agentMascot("custom-123", "custom")).toBe(agentMascot("custom-123"));
    expect(agentMascot("renamed-slug", "custom", "custom-123")).toBe(agentMascot("custom-123"));
  });
  it.each(CUSTOM_AGENT_MASCOT_PRESETS)("uses an allowlisted %s override and ships original dog art", (preset) => {
    const path = agentMascot("coding-coworker", "engineering", "custom-id", preset);
    const original = new URL(`../../web/public${path}`, import.meta.url);
    expect(existsSync(original)).toBe(true);
    expect(readFileSync(original).subarray(8, 12).toString()).toBe("WEBP");
  });
});
