import type { AuditEnv } from "./audit.js";
import { resolveActiveSkillPins, type SkillPin } from "./skills-store.js";

type SelectedPin = { skillId: string; version: number; name: string; sourceUrl?: string; contentSha256?: string };

/**
 * Freezes a bot's attached skills into the task an approver sees. The pins
 * carry a content digest so dispatch can refuse a run whose skill text no
 * longer matches what was approved.
 */
export class BotSkillAttachment {
  static readonly MAX_PINS = 5;

  constructor(private readonly env: AuditEnv, private readonly orgId: string) {}

  async apply(
    task: string,
    selected: readonly SelectedPin[] | undefined,
    attached: readonly { skillId: string; version: number }[] | undefined,
  ): Promise<{ task: string; pins: SelectedPin[] | undefined }> {
    if (!attached?.length) return { task, pins: selected ? [...selected] : undefined };
    const selectedIds = new Set((selected ?? []).map((pin) => pin.skillId));
    const additional = attached.filter((pin) => !selectedIds.has(pin.skillId));
    if (additional.length + selectedIds.size > BotSkillAttachment.MAX_PINS) throw new BotSkillAttachmentError("too_many_skills");
    const resolved = await resolveActiveSkillPins(this.env, this.orgId, additional);
    if (!resolved) throw new BotSkillAttachmentError("bot_skill_unavailable");
    if (!resolved.pins.length) return { task, pins: selected ? [...selected] : undefined };
    const pins: SelectedPin[] = [...(selected ?? []), ...resolved.pins.map((pin: SkillPin) => ({ ...pin }))];
    return { task: `${task}\n\nBot-attached reviewed skills:\n${resolved.sections.join("\n\n")}`, pins };
  }
}

export class BotSkillAttachmentError extends Error {
  constructor(readonly code: "too_many_skills" | "bot_skill_unavailable") {
    super(code === "too_many_skills"
      ? "The bot's attached skills and selected skills exceed the five-skill limit. Deselect a skill."
      : "A skill attached to this bot is no longer active at its pinned version. Re-activate it or update the bot.");
  }
}
