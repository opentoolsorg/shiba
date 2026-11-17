import { uiBlockFallbackQuestions, type UiBlock, type UiAnswer } from "@shiba/shared";
import type { Env } from "./env.js";
import { parseSlackThreadName } from "./slack-thread.js";
import { answerUiBlock, getUiBlock, UiBlockError } from "./ui-block-store.js";

const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
const confirmation = () => ({ title: plain("Confirm destructive choice"), text: plain("This choice is destructive. Are you sure?"), confirm: plain("Confirm"), deny: plain("Cancel"), style: "danger" });

function value(runId: string, blockId: string, optionId: string, confirmed = false): string {
  const encoded = JSON.stringify({ runId, blockId, optionId, ...(confirmed ? { confirmed: true } : {}) });
  if (encoded.length > 2000) throw new Error("Slack UI block pointer exceeds 2000 characters.");
  return encoded;
}

export function renderUiBlockToSlack(block: UiBlock, { runId }: { runId: string }): { text: string; blocks: unknown[] } {
  const text = uiBlockFallbackQuestions(block);
  const blocks: unknown[] = [{ type: "section", text: plain(block.prompt) }];
  const button = (optionId: string, label: string, danger = false) => ({
    type: "button", text: plain(label), action_id: `ui_block:button:${optionId}`,
    value: value(runId, block.id, optionId, danger),
    ...(danger ? { style: "danger", confirm: confirmation() } : {}),
  });
  if (block.type === "form") {
    for (let i = 0; i < text.length; i += 2500) blocks.push({ type: "section", text: plain(text.slice(i, i + 2500)) });
    blocks.push({ type: "context", elements: [plain("Fill in this form in the dashboard; Slack modals are not supported here.")] });
  } else if (block.type === "confirm") {
    blocks.push({ type: "actions", elements: [button("yes", block.confirmLabel, block.danger), button("no", block.cancelLabel)] });
  } else if (block.type === "quick_replies" || (!block.multiple && block.options.length <= 5)) {
    blocks.push({ type: "actions", elements: block.options.map((option) => button(option.id, option.label, option.danger)) });
  } else if (!block.multiple) {
    const danger = block.options.some((option) => option.danger);
    blocks.push({ type: "actions", elements: [{ type: "static_select", action_id: "ui_block:select", placeholder: plain("Choose an option"),
      options: block.options.map((option) => ({ text: plain(option.label), value: value(runId, block.id, option.id, danger) })),
      ...(danger ? { confirm: confirmation() } : {}),
    }] });
  } else {
    for (let i = 0; i < block.options.length; i += 10) {
      blocks.push({ type: "actions", block_id: `ui_block:${block.id}:${i}`, elements: [{ type: "checkboxes", action_id: "ui_block:selection",
        options: block.options.slice(i, i + 10).map((option) => ({ text: plain(option.danger ? `${option.label.slice(0, 61)} (destructive)` : option.label), value: value(runId, block.id, option.id) })),
      }] });
    }
    blocks.push({ type: "actions", elements: [button("submit", "Submit choices", block.options.some((option) => option.danger))] });
  }
  return { text, blocks };
}

interface Pointer { runId: string; blockId: string; optionId: string; confirmed?: boolean }
function pointer(raw: unknown): Pointer {
  if (typeof raw !== "string" || raw.length > 2000) throw new Error("Invalid question pointer.");
  const p = JSON.parse(raw) as Pointer;
  if (!p || typeof p.runId !== "string" || typeof p.blockId !== "string" || typeof p.optionId !== "string" || (p.confirmed !== undefined && p.confirmed !== true)) throw new Error("Invalid question pointer.");
  return p;
}

export interface SlackUiPayload {
  team?: { id?: string }; channel?: { id?: string }; message?: { thread_ts?: string; ts?: string };
  actions?: { action_id?: string; value?: string; selected_option?: { value?: string } }[];
  state?: { values?: Record<string, Record<string, { selected_options?: { value?: string }[] }>> };
}

/** Called only after Slack signature verification and approver allowlist checks. */
export async function answerSlackUiBlock(env: Env, payload: SlackUiPayload): Promise<string | null> {
  const action = payload.actions?.[0];
  if (action?.action_id === "ui_block:selection") return null;
  const p = pointer(action?.selected_option?.value ?? action?.value);
  const thread = parseSlackThreadName(p.runId);
  if (!thread || thread.teamId !== payload.team?.id || thread.channelId !== payload.channel?.id || thread.threadTs !== (payload.message?.thread_ts ?? payload.message?.ts)) throw new Error("Question does not belong to this Slack thread.");
  const { chatLaneActorId } = await import("./chat-employee.js");
  const ownerId = chatLaneActorId(env, p.runId);
  if (!ownerId) throw new Error("Question has no configured chat owner.");
  const question = await getUiBlock(env, ownerId, p.runId, p.blockId);
  if (!question) throw new Error("Question not found.");
  let answer: UiAnswer;
  if (question.block.type === "confirm") {
    if (p.optionId !== "yes" && p.optionId !== "no") throw new Error("Invalid confirmation choice.");
    if (p.optionId === "yes" && question.block.danger && p.confirmed !== true) throw new Error("danger_requires_confirm");
    answer = { blockId: p.blockId, confirmed: p.optionId === "yes" };
  } else if (question.block.type === "choice" && question.block.multiple) {
    if (p.optionId !== "submit") throw new Error("Submit the selected choices.");
    const options: string[] = [];
    for (const [blockId, actions] of Object.entries(payload.state?.values ?? {})) {
      if (!blockId.startsWith(`ui_block:${p.blockId}:`)) continue;
      for (const selected of actions["ui_block:selection"]?.selected_options ?? []) {
        const item = pointer(selected.value);
        if (item.runId !== p.runId || item.blockId !== p.blockId) throw new Error("Invalid selected question.");
        options.push(item.optionId);
      }
    }
    answer = { blockId: p.blockId, optionIds: options, confirmed: p.confirmed === true };
  } else {
    answer = { blockId: p.blockId, optionIds: [p.optionId], confirmed: p.confirmed === true };
  }
  try { await answerUiBlock(env, ownerId, p.runId, p.blockId, answer, "slack"); }
  catch (error) { if (error instanceof UiBlockError && error.errors?.length) throw new Error(error.errors.join(", ")); throw error; }
  const chosen = question.block.type === "confirm" ? (answer.confirmed ? question.block.confirmLabel : question.block.cancelLabel)
    : question.block.type === "form" ? "Form submitted" : question.block.options.filter((option) => answer.optionIds?.includes(option.id)).map((option) => option.label).join(", ");
  return `Answered: ${chosen}.`;
}
