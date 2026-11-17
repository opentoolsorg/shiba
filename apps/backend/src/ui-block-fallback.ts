import { parseUiBlockFallbackReply } from "@shiba/shared";
import type { Env } from "./env.js";
import { answerUiBlock, listUiBlocks, UiBlockError } from "./ui-block-store.js";

export async function tryAnswerUiBlockFallback(env: Env, threadId: string, senderId: string, text: string): Promise<boolean> {
  if (!env.AGENT_AUDIT || !env.CHAT_EMPLOYEE_ACTOR?.trim()) return false;
  const allowlist = threadId.startsWith("slack:") ? env.SLACK_APPROVERS
    : threadId.startsWith("telegram:") ? env.TELEGRAM_APPROVERS : env.DISCORD_APPROVERS;
  if (!senderId || !allowlist?.split(",").map((id) => id.trim()).includes(senderId)) return false;
  const { chatLaneActorId } = await import("./chat-employee.js");
  const ownerId = chatLaneActorId(env, threadId);
  if (!ownerId) return false;
  const latest = (await listUiBlocks(env, ownerId, threadId, true, true))[0];
  if (!latest || latest.status !== "pending") return false;
  const answer = parseUiBlockFallbackReply(latest.block, text);
  if ("error" in answer) return false;
  try { await answerUiBlock(env, ownerId, latest.runId, latest.blockId, answer, "fallback"); }
  catch (error) { if (!(error instanceof UiBlockError && error.status === 409)) throw error; }
  return true;
}
