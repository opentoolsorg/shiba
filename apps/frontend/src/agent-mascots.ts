import {
  CUSTOM_AGENT_MASCOT_PRESETS,
  defaultLookFor,
  resolveAgentMascotLook,
  type AgentMascotEyes,
  type AgentMascotLook,
  type CustomAgentMascotPreset,
} from "@shiba/shared";
import type { EmployeeRole } from "./employee-templates";

export type AgentAvatarStatus = "idle" | "working" | "waiting" | "needs-approval" | "failed" | "asleep";

const templatePresets: Record<string, CustomAgentMascotPreset> = {
  shiba: "hero",
  "coding-coworker": "hero", "pr-reviewer": "sunglasses", "slack-digester": "sleeping",
  "standup-summarizer": "sleeping", "product-spec-writer": "climbing", "prototype-builder": "riding",
  "competitor-watch": "sunglasses", "support-triage": "hero", "slack-coworker": "hero",
  "roster-manager": "riding", "reason-engineering-lead": "climbing",
};
const rolePresets: Partial<Record<EmployeeRole, CustomAgentMascotPreset>> = {
  engineering: "hero", marketing: "riding", sales: "hero", research: "sunglasses", product: "climbing",
  design: "riding", qa: "sunglasses", operations: "sleeping", gtm: "climbing", hr: "hero", finance: "sunglasses",
};

export function agentMascotPreset(id: string, role?: EmployeeRole, fallbackId = id): CustomAgentMascotPreset {
  const known = templatePresets[id] ?? (role ? rolePresets[role] : undefined);
  const hash = Array.from(fallbackId).reduce((value, character) => (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0, 0);
  return known ?? CUSTOM_AGENT_MASCOT_PRESETS[hash % CUSTOM_AGENT_MASCOT_PRESETS.length]!;
}

export function resolveAgentLook(input: {
  id: string;
  role?: EmployeeRole;
  fallbackId?: string;
  preset?: CustomAgentMascotPreset;
  look?: unknown;
}): AgentMascotLook {
  return resolveAgentMascotLook({
    id: input.id,
    role: input.role,
    fallbackId: input.fallbackId,
    preset: input.preset,
    look: input.look,
  });
}

/** Live face for the run state. Idle keeps the chosen eyes. */
export function mascotExpression(status: AgentAvatarStatus | undefined, eyes: AgentMascotEyes): AgentMascotEyes {
  switch (status) {
    case "working":
      return "code";
    case "waiting":
    case "asleep":
      return "sleepy";
    case "needs-approval":
      return "surprised";
    case "failed":
      return "squint";
    default:
      return eyes;
  }
}

export function avatarStatusFromTask(status: string | undefined): AgentAvatarStatus | undefined {
  if (!status) return undefined;
  if (status === "running" || status === "working" || status === "in-progress" || status === "live") return "working";
  if (status === "needs-approval" || status === "waiting-approval") return "needs-approval";
  if (status === "waiting" || status === "in-review") return "waiting";
  if (status === "failed" || status === "error") return "failed";
  if (status === "asleep") return "asleep";
  return undefined;
}
