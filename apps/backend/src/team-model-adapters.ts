import { TEAM_MODEL_LLAMA_MODEL, TEAM_MODEL_TEXT_MODEL } from "@shiba/shared";
import { z } from "zod";
import { redactSecrets } from "./security.js";
import { TeamModelError, type TeamModelInput } from "./team-model-store.js";

const messages = z.tuple([
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
]);
const llamaInput = z.object({ messages, max_tokens: z.number().int().min(1).max(1024), stream: z.literal(false) }).strict();
const glmInput = z.object({
  messages, max_completion_tokens: z.number().int().min(1).max(1024), stream: z.literal(false), n: z.literal(1),
  modalities: z.tuple([z.literal("text")]), tool_choice: z.literal("none"), store: z.literal(false),
  chat_template_kwargs: z.object({ enable_thinking: z.literal(false) }).strict(),
}).strict();

/** Only these fixed text operations have an approved metering envelope. */
export function requireTeamModelTextInput(value: unknown, model: string, maxOutputTokens: number): TeamModelInput {
  const schema = model === TEAM_MODEL_LLAMA_MODEL ? llamaInput : model === TEAM_MODEL_TEXT_MODEL ? glmInput : null;
  const parsed = schema?.safeParse(value);
  if (!parsed?.success || ("max_tokens" in parsed.data ? parsed.data.max_tokens : parsed.data.max_completion_tokens) !== maxOutputTokens) throw new TeamModelError("team_model_input_policy_changed", 403);
  return parsed.data;
}
function hasUnsupportedOutput(value: object): boolean {
  const fields = value as Record<string, unknown>;
  return ["tool_calls", "function_call", "audio", "images"].some((key) => fields[key] !== undefined && fields[key] !== null);
}
export function teamModelTextOutput(value: unknown, model: string): string {
  if (!value || typeof value !== "object" || hasUnsupportedOutput(value)) throw new TeamModelError("team_model_output_unconfirmed");
  let content: string;
  if (model === TEAM_MODEL_LLAMA_MODEL) {
    if (!("response" in value) || typeof value.response !== "string") throw new TeamModelError("team_model_output_unconfirmed");
    content = value.response;
  } else if (model === TEAM_MODEL_TEXT_MODEL) {
    if (!("choices" in value) || !Array.isArray(value.choices) || value.choices.length !== 1) throw new TeamModelError("team_model_output_unconfirmed");
    const choice: unknown = value.choices[0];
    if (!choice || typeof choice !== "object" || hasUnsupportedOutput(choice) || !("message" in choice) || !choice.message || typeof choice.message !== "object" || hasUnsupportedOutput(choice.message) || !("content" in choice.message) || typeof choice.message.content !== "string") throw new TeamModelError("team_model_output_unconfirmed");
    content = choice.message.content;
  } else throw new TeamModelError("team_model_output_unconfirmed");
  const text = redactSecrets(content), bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= 8192) return text;
  const suffix = "\n[truncated]";
  // Keep a partial trailing UTF-8 code point from expanding the byte ceiling.
  return new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(bytes.subarray(0, 8192 - new TextEncoder().encode(suffix).byteLength), { stream: true }) + suffix;
}
