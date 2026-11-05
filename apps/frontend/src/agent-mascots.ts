import type { EmployeeRole } from "./employee-templates";

const mascots = ["agni", "chanakya", "kavi", "mitra", "shravan", "ved", "vishwa"] as const;
const templateMascots: Record<string, (typeof mascots)[number]> = {
  "coding-coworker": "agni", "pr-reviewer": "ved", "slack-digester": "shravan",
  "standup-summarizer": "shravan", "product-spec-writer": "chanakya", "prototype-builder": "vishwa",
  "competitor-watch": "ved", "support-triage": "mitra", "slack-coworker": "mitra",
  "roster-manager": "kavi", "reason-engineering-lead": "chanakya",
};
const roleMascots: Partial<Record<EmployeeRole, (typeof mascots)[number]>> = {
  engineering: "agni", marketing: "kavi", sales: "mitra", research: "ved", product: "chanakya",
  design: "vishwa", operations: "shravan", gtm: "chanakya", hr: "mitra", finance: "ved",
};

export function agentMascot(id: string, role?: EmployeeRole, fallbackId = id): string {
  const known = templateMascots[id] ?? (role ? roleMascots[role] : undefined);
  const hash = Array.from(fallbackId).reduce((value, character) => (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0, 0);
  return `/assets/agents/${known ?? mascots[hash % mascots.length]}.png`;
}
