import { CUSTOM_AGENT_MASCOT_PRESETS, type CustomAgentMascotPreset } from "@shiba/shared";
import type { EmployeeRole } from "./employee-templates";

const templateMascots: Record<string, CustomAgentMascotPreset> = {
  shiba: "hero",
  "coding-coworker": "hero", "pr-reviewer": "sunglasses", "slack-digester": "sleeping",
  "standup-summarizer": "sleeping", "product-spec-writer": "climbing", "prototype-builder": "riding",
  "competitor-watch": "sunglasses", "support-triage": "hero", "slack-coworker": "hero",
  "roster-manager": "riding", "reason-engineering-lead": "climbing",
};
const roleMascots: Partial<Record<EmployeeRole, CustomAgentMascotPreset>> = {
  engineering: "hero", marketing: "riding", sales: "hero", research: "sunglasses", product: "climbing",
  design: "riding", qa: "sunglasses", operations: "sleeping", gtm: "climbing", hr: "hero", finance: "sunglasses",
};

export function agentMascotPreset(id: string, role?: EmployeeRole, fallbackId = id): CustomAgentMascotPreset {
  const known = templateMascots[id] ?? (role ? roleMascots[role] : undefined);
  const hash = Array.from(fallbackId).reduce((value, character) => (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0, 0);
  return known ?? CUSTOM_AGENT_MASCOT_PRESETS[hash % CUSTOM_AGENT_MASCOT_PRESETS.length]!;
}

export function agentMascot(id: string, role?: EmployeeRole, fallbackId = id, preset?: CustomAgentMascotPreset): string {
  const selected = preset && CUSTOM_AGENT_MASCOT_PRESETS.includes(preset) ? preset : agentMascotPreset(id, role, fallbackId);
  return `/assets/mascot/shiba-sticker-${selected}.webp`;
}
