import { z } from "zod";

export const UI_BLOCK_VERSION = 1 as const;

const plain = (max: number, required = true) => z.string().max(max).refine(
  (value) => (!required || value.trim().length > 0) && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
  }) && !/<\/?[a-z!]|<\/|&(?:lt|gt|#\d+|#x[\da-f]+);/i.test(value),
  "Expected plain text without markup or control characters",
);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const label = plain(75);
const option = z.object({ id, label, description: plain(200).optional(), danger: z.boolean().optional() }).strict();
const quickOption = option.omit({ description: true });
const fieldBase = { id, label, required: z.boolean().optional(), placeholder: plain(150).optional() };
const field = z.discriminatedUnion("kind", [
  z.object({ ...fieldBase, kind: z.literal("text"), maxLength: z.number().int().positive().max(8000).optional() }).strict(),
  z.object({ ...fieldBase, kind: z.literal("textarea"), maxLength: z.number().int().positive().max(8000).optional() }).strict(),
  z.object({ ...fieldBase, kind: z.literal("select"), options: z.array(quickOption).min(1).max(25) }).strict(),
  z.object({ ...fieldBase, kind: z.literal("checkbox") }).strict(),
]);
const common = { version: z.literal(UI_BLOCK_VERSION), id, title: label.optional(), fallbackText: plain(2000).optional(), prompt: plain(2000) };

function utf8Size(text: string): number {
  let size = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

export const uiBlockSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("confirm"), confirmLabel: label, cancelLabel: label, danger: z.boolean().optional() }).strict(),
  z.object({ ...common, type: z.literal("quick_replies"), options: z.array(quickOption).min(1).max(10) }).strict(),
  z.object({ ...common, type: z.literal("choice"), options: z.array(option).min(2).max(25), multiple: z.boolean().optional(), minSelections: z.number().int().min(0).optional(), maxSelections: z.number().int().positive().optional() }).strict(),
  z.object({ ...common, type: z.literal("form"), fields: z.array(field).min(1).max(8), submitLabel: label }).strict(),
]).superRefine((block, ctx) => {
  const ids = [block.id];
  if (block.type === "choice" || block.type === "quick_replies") ids.push(...block.options.map((item) => item.id));
  if (block.type === "form") {
    for (const item of block.fields) {
      ids.push(item.id);
      if (item.kind === "select") ids.push(...item.options.map((entry) => entry.id));
    }
  }
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate ids within block" });
  if (block.type === "choice") {
    const max = block.maxSelections ?? (block.multiple ? block.options.length : 1);
    const min = block.minSelections ?? 1;
    if (min > max || max > block.options.length || (!block.multiple && max > 1)) {
      ctx.addIssue({ code: "custom", message: "Inconsistent choice selection bounds" });
    }
  }
  if (utf8Size(JSON.stringify(block)) > 8192) ctx.addIssue({ code: "custom", message: "Block exceeds 8 KB" });
});

export type UiBlock = z.infer<typeof uiBlockSchema>;
export const uiAnswerSchema = z.object({
  blockId: id,
  optionIds: z.array(id).max(25).optional(),
  values: z.record(id, z.union([plain(8000, false), z.boolean()])).optional(),
  confirmed: z.boolean().optional(),
}).strict();
export type UiAnswer = z.infer<typeof uiAnswerSchema>;
type Result<T> = { ok: true } & T | { ok: false; errors: string[] };

export function parseUiBlock(input: unknown): Result<{ block: UiBlock }> {
  const parsed = uiBlockSchema.safeParse(input);
  return parsed.success ? { ok: true, block: parsed.data } : { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
}

export function validateUiAnswer(block: UiBlock, input: unknown): Result<{ answer: UiAnswer }> {
  const parsed = uiAnswerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  const answer = parsed.data;
  const errors: string[] = [];
  if (answer.blockId !== block.id) errors.push("block_id_mismatch");
  if (block.type === "confirm") {
    if (typeof answer.confirmed !== "boolean" || answer.optionIds !== undefined || answer.values !== undefined) errors.push("invalid_confirm_answer");
    if (block.danger && answer.confirmed === undefined) errors.push("danger_requires_confirm");
  } else if (block.type === "form") {
    if (answer.optionIds !== undefined) errors.push("unexpected_option_ids");
    const values = answer.values ?? {};
    if (Object.keys(values).some((key) => !block.fields.some((item) => item.id === key))) errors.push("unknown_field_id");
    for (const item of block.fields) {
      const value = values[item.id];
      if (item.required && (value === undefined || value === false || (typeof value === "string" && !value.trim()))) errors.push(`required_field:${item.id}`);
      if (value === undefined) continue;
      if (item.kind === "checkbox") {
        if (typeof value !== "boolean") errors.push(`invalid_checkbox:${item.id}`);
      } else if (typeof value !== "string") errors.push(`invalid_field:${item.id}`);
      else if (item.kind === "select") {
        const selected = item.options.find((entry) => entry.id === value);
        if (!selected) errors.push(`unknown_option_id:${item.id}`);
        if (selected?.danger && answer.confirmed !== true) errors.push("danger_requires_confirm");
      } else if (item.maxLength !== undefined && value.length > item.maxLength) errors.push(`max_length:${item.id}`);
    }
  } else {
    if (answer.values !== undefined) errors.push("unexpected_values");
    const selected = answer.optionIds ?? [];
    if (new Set(selected).size !== selected.length) errors.push("duplicate_option_ids");
    if (selected.some((key) => !block.options.some((item) => item.id === key))) errors.push("unknown_option_id");
    const min = block.type === "choice" ? block.minSelections ?? 1 : 1;
    const max = block.type === "choice" ? block.maxSelections ?? (block.multiple ? block.options.length : 1) : 1;
    if (selected.length < min || selected.length > max) errors.push("choice_bounds");
    if (block.options.some((item) => item.danger && selected.includes(item.id)) && answer.confirmed !== true) errors.push("danger_requires_confirm");
  }
  return errors.length ? { ok: false, errors } : { ok: true, answer };
}

export function uiBlockFallbackQuestions(block: UiBlock): string {
  const lines = [block.title, block.prompt, block.fallbackText].filter((value): value is string => value !== undefined);
  if (block.type === "confirm") lines.push(`Yes: ${block.confirmLabel}${block.danger ? " (destructive)" : ""}; No: ${block.cancelLabel}`, `Reply yes/no.${block.danger ? " Include the word confirm to proceed." : ""}`);
  else if (block.type === "form") {
    for (const item of block.fields) {
      const options = item.kind === "select" ? ` (${item.options.map((entry, index) => `${index + 1}. ${entry.label}${entry.danger ? " (destructive)" : ""}`).join("; ")})` : item.kind === "checkbox" ? " (yes/no)" : "";
      lines.push(`${item.label}:${item.required ? " (required)" : ""}${options}`);
    }
    lines.push(`Reply with field label: value, one field per line. ${block.submitLabel}. Include the word confirm on its own line for destructive selections.`);
  } else {
    block.options.forEach((item, index) => lines.push(`${index + 1}. ${item.label}${item.danger ? " (destructive)" : ""}${"description" in item && item.description ? ` — ${item.description}` : ""}`));
    lines.push("Reply with the number(s) or option labels, separated by commas. Include the word confirm for destructive selections.");
  }
  return lines.join("\n");
}

function selectOption(options: { id: string; label: string }[], text: string): string | undefined {
  const matches = options.filter((item) => item.label.trim().toLowerCase() === text.trim().toLowerCase());
  if (matches.length === 1) return matches[0]!.id;
  if (/^[1-9]\d*$/.test(text.trim())) return options[Number(text.trim()) - 1]?.id;
  return undefined;
}

export function parseUiBlockFallbackReply(block: UiBlock, text: string): UiAnswer | { error: string } {
  const explicitConfirm = /\bconfirm\b/i.test(text);
  const clean = text.trim();
  let answer: UiAnswer;
  if (block.type === "confirm") {
    const reply = clean.replace(/\bconfirm\b/gi, "").trim().toLowerCase();
    if (["no", "n", block.cancelLabel.toLowerCase()].includes(reply) || clean.toLowerCase() === block.cancelLabel.toLowerCase()) answer = { blockId: block.id, confirmed: false };
    else if (["yes", "y", block.confirmLabel.toLowerCase()].includes(reply) || clean.toLowerCase() === block.confirmLabel.toLowerCase()) {
      if (block.danger && !explicitConfirm) return { error: "danger_requires_confirm" };
      answer = { blockId: block.id, confirmed: true };
    } else return { error: "Expected yes/no" };
  } else if (block.type === "form") {
    const values: Record<string, string | boolean> = {};
    for (const line of clean.split("\n")) {
      if (/^confirm$/i.test(line.trim()) || !line.trim()) continue;
      const separator = line.indexOf(":");
      if (separator < 0) return { error: "Expected field label: value" };
      const key = line.slice(0, separator).trim().toLowerCase();
      const matches = block.fields.filter((item) => item.label.toLowerCase() === key || item.id === key);
      if (matches.length !== 1) return { error: "Unknown or ambiguous field" };
      const item = matches[0]!;
      if (Object.hasOwn(values, item.id)) return { error: "Duplicate field" };
      const value = line.slice(separator + 1).trim();
      if (item.kind === "checkbox") {
        if (!/^(yes|no|true|false)$/i.test(value)) return { error: "Expected yes/no checkbox value" };
        values[item.id] = /^(yes|true)$/i.test(value);
      } else if (item.kind === "select") {
        const selected = selectOption(item.options, value);
        if (!selected) return { error: "Unknown select option" };
        values[item.id] = selected;
      } else values[item.id] = value;
    }
    answer = { blockId: block.id, values, confirmed: explicitConfirm };
  } else {
    const raw = selectOption(block.options, clean);
    const withoutConfirm = clean.replace(/\bconfirm\b/gi, "").trim();
    const whole = raw ?? selectOption(block.options, withoutConfirm);
    const parts = whole ? [whole] : withoutConfirm === "" ? [] : withoutConfirm.split(/[,\n]+|\s+(?=\d+(?:\s|$))/).map((part) => selectOption(block.options, part.trim()));
    if (parts.some((part) => part === undefined)) return { error: "Unknown or ambiguous option" };
    answer = { blockId: block.id, optionIds: parts as string[], confirmed: explicitConfirm };
  }
  const checked = validateUiAnswer(block, answer);
  return checked.ok ? checked.answer : { error: checked.errors.join(", ") };
}
