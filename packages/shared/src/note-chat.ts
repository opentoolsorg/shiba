import { z } from "zod";

export const noteChatMentionSchema = z.object({
  kind: z.enum(["note", "file"]), id: z.string().min(1).max(200), name: z.string().min(1).max(300),
});
export const noteChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000), mentions: z.array(noteChatMentionSchema).max(8).default([]),
  noteBody: z.string().max(24000).optional(),
});
export const noteChatMessageSchema = z.object({
  id: z.string(), noteId: z.string(), role: z.enum(["user", "assistant"]), content: z.string(),
  mentions: z.array(noteChatMentionSchema), createdAt: z.number(),
});
export type NoteChatMention = z.infer<typeof noteChatMentionSchema>;
export type NoteChatRequest = z.infer<typeof noteChatRequestSchema>;
export type NoteChatMessage = z.infer<typeof noteChatMessageSchema>;
