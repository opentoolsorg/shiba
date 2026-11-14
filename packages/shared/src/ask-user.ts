/**
 * WS08 owns this schema; WS10 registers the `ask_user` tool against it.
 * Choice questions use two to four one-line options.
 */
import { z } from "zod";

export const ASK_USER_TOOL_NAME = "ask_user" as const;

export const askUserChoiceSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
});

export const askUserConnectAppSchema = z.object({
  providerKey: z.string().min(1).max(120),
  label: z.string().min(1).max(240),
  connectUrl: z.string().url().max(2000),
});

const askUserCommon = {
  askId: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  allowFreeText: z.boolean().optional(),
  freeTextLabel: z.string().max(240).optional(),
};

export const askUserSingleChoiceSchema = z
  .object({
    ...askUserCommon,
    mode: z.literal("single_choice"),
    choices: z.array(askUserChoiceSchema).min(2).max(4),
  })
  .strict();

export const askUserMultiChoiceSchema = z
  .object({
    ...askUserCommon,
    mode: z.literal("multi_choice"),
    choices: z.array(askUserChoiceSchema).min(2).max(4),
    minSelections: z.number().int().min(0).max(4).optional(),
    maxSelections: z.number().int().min(1).max(4).optional(),
  })
  .strict();

export const askUserFreeTextSchema = z
  .object({
    ...askUserCommon,
    mode: z.literal("free_text"),
    placeholder: z.string().max(500).optional(),
  })
  .strict();

export const askUserConnectAppRequestSchema = z
  .object({
    ...askUserCommon,
    mode: z.literal("connect_app"),
    app: askUserConnectAppSchema,
  })
  .strict();

export const askUserRequestSchema = z.discriminatedUnion("mode", [
  askUserSingleChoiceSchema,
  askUserMultiChoiceSchema,
  askUserFreeTextSchema,
  askUserConnectAppRequestSchema,
]);

export type AskUserRequest = z.infer<typeof askUserRequestSchema>;

export const askUserAnswerSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("single_choice"),
      choiceId: z.string().min(1).max(120),
      freeText: z.string().max(8000).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("multi_choice"),
      choiceIds: z.array(z.string().min(1).max(120)).min(1).max(4),
      freeText: z.string().max(8000).optional(),
    })
    .strict(),
  z.object({ mode: z.literal("free_text"), text: z.string().min(1).max(8000) }).strict(),
  z
    .object({
      mode: z.literal("connect_app"),
      connected: z.boolean(),
      note: z.string().max(2000).optional(),
    })
    .strict(),
]);

export type AskUserAnswer = z.infer<typeof askUserAnswerSchema>;

export interface AskUserReceipt {
  commandId: string;
  kind: "ask_user.answer";
  askId: string;
  runId: string;
  request: AskUserRequest;
  answer: AskUserAnswer;
  at: number;
}