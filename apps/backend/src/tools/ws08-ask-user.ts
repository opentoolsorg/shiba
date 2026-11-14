import type { Env } from "../env.js";
import type { ToolRegistry } from "../mcp-gateway.js";
import {
  ASK_USER_TOOL_NAME,
  askUserRequestSchema,
} from "@shiba/shared";
import { z } from "zod";

/** True when the WS08 schema is on main; mirrors packages/shared/src/ask-user.ts. */
export const ASK_USER_PUBLISHED = true;

const askUserMcpShape = {
  askId: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  mode: z.enum(["single_choice", "multi_choice", "free_text", "connect_app"]),
  allowFreeText: z.boolean().optional(),
  freeTextLabel: z.string().max(240).optional(),
  choices: z.array(z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(500),
    description: z.string().max(2000).optional(),
  })).optional(),
  minSelections: z.number().int().min(0).max(12).optional(),
  maxSelections: z.number().int().min(1).max(12).optional(),
  placeholder: z.string().max(500).optional(),
  app: z.object({
    providerKey: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
    connectUrl: z.string().url().max(2000),
  }).optional(),
};

export function registerAskUserTool(registry: ToolRegistry, _env: Env): void {
  if (!ASK_USER_PUBLISHED) return;
  registry.registerTool(
    ASK_USER_TOOL_NAME,
    "api:write",
    async (args) => {
      const parsed = askUserRequestSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "invalid_ask_user_request" }) }],
          structuredContent: { ok: false, error: "invalid_ask_user_request" },
          isError: true,
        };
      }
      const payload = {
        ok: true,
        status: "pending_user_response",
        request: parsed.data,
        note: "Awaiting dashboard or Slack card submission (WS08 render path).",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
    {
      description:
        "Ask the human a structured question (single/multi choice, free text, or connect-app). " +
        "Validated against the WS08 ask-user schema; execution completes when the user answers.",
      inputSchema: askUserMcpShape,
      annotations: { readOnlyHint: false },
    },
  );
}