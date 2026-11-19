import { generateText, type FinishReason, type LanguageModel, type ModelMessage, type UIMessage } from "ai";
import { z } from "zod";

const boundedText = z.string().trim().min(1).max(4000);
export const sideQuestionSchema = z.object({
  question: boundedText,
  threadId: z.string().min(1).max(128),
  earlier: z.array(z.object({ question: boundedText, answer: z.string().max(16000) })).max(20).default([]),
});

export function generateEmployeeChat(model: LanguageModel, instructions: string, messages: ModelMessage[]): Promise<{ text: string; finishReason: FinishReason }> {
  return generateText({ model, system: instructions, messages, tools: {}, maxOutputTokens: 2048, abortSignal: AbortSignal.timeout(60000) });
}

export async function answerSideQuestion(
  input: z.infer<typeof sideQuestionSchema>,
  instructions: string,
  tail: UIMessage[],
  model: () => LanguageModel,
): Promise<Response> {
  const messages: ModelMessage[] = tail.slice(-25).filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(-16000) })).filter((message) => message.content.trim());
  for (const pair of input.earlier) messages.push({ role: "user", content: pair.question }, { role: "assistant", content: pair.answer });
  messages.push({ role: "user", content: input.question });
  try {
    const result = await generateEmployeeChat(model(), instructions || "You are Shiba, a helpful conversational assistant.", messages);
    return Response.json({ answer: result.text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const busy = isProviderBusy(error);
    return Response.json({ error: busy ? "The chat provider is busy or over its limit. Please try again shortly." : "The side question could not be answered. Please try again." }, { status: busy ? 409 : 502, headers: { "Cache-Control": "no-store" } });
  }
}

function isProviderBusy(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const record = error as { statusCode?: number; status?: number; message?: string; responseBody?: string; cause?: unknown; lastError?: unknown };
  return [429, 503, 529].includes(record.statusCode ?? record.status ?? 0) ||
    /rate.?limit|overload|concurren|too many requests|\bbusy\b|resource.?exhausted/i.test(`${record.message ?? ""} ${record.responseBody ?? ""}`) ||
    isProviderBusy(record.lastError ?? record.cause, depth + 1);
}
