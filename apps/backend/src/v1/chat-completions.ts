import { boundedBody } from "@shiba/openconnector-read-gateway";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { getCustomAgentBySlug } from "../custom-agents-store.js";
import type { Env } from "../env.js";
import { DASHBOARD_ORG_ID } from "../org-request-auth.js";
import { requireJsonContentType } from "../request-auth.js";
import { DEFAULT_ORCHESTRATOR_MODEL } from "../session-distill.js";
import { generateEmployeeChat } from "../side-question.js";
import { authorizeV1ApiKey, requireV1Write } from "../v1-auth.js";

const inputSchema = z.strictObject({
  model: z.string().regex(/^shiba\/[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/),
  messages: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4000),
  })).min(1).max(20),
  stream: z.literal(false).optional(),
});
const headers = { "Cache-Control": "no-store" };

function error(status: number, message: string, type = "invalid_request_error", extra?: Record<string, string>): Response {
  return Response.json({ error: { message, type } }, { status, headers: { ...headers, ...extra } });
}

export async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const auth = await authorizeV1ApiKey(request, env);
  if (auth instanceof Response) return auth.status === 429
    ? error(429, "API key rate limit exceeded.", "rate_limit_error")
    : error(401, "A valid Shiba API key is required.", "authentication_error");
  if (!requireV1Write(auth) || auth.orgId !== DASHBOARD_ORG_ID || request.headers.has("X-Shiba-Workspace")) {
    return error(403, "Chat completions require a self-hosted API key with api:write and no workspace override.", "permission_error");
  }
  if (request.method !== "POST") return error(405, "Use POST.", undefined, { Allow: "POST" });
  if (requireJsonContentType(request)) return error(415, "Content-Type must be application/json.");
  let input: unknown;
  try {
    const bytes = await boundedBody(request.body, 96 * 1024, request.signal);
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return error(400, "Provide valid JSON of at most 96 KiB.");
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.messages.at(-1)?.role !== "user") {
    return error(400, "Provide a shiba/<employee-slug> model and 1–20 plain-text user or assistant messages ending with a user message. Only stream: false is supported.");
  }
  if (!env.AGENT_AUDIT || !env.AI) return error(503, "Employee chat is unavailable.", "server_error");
  const { model, messages } = parsed.data;
  try {
    const employee = await getCustomAgentBySlug(env, auth.orgId, model.slice("shiba/".length));
    if (!employee) return error(404, "Employee not found.");
    const instructions = [
      employee.config.instructions || "You are Shiba, a helpful conversational assistant.",
      "This is Chat mode. Answer in text only. Do not use tools, delegate work, or claim to have taken an action.",
    ].join("\n\n");
    const ai = createWorkersAI({ binding: env.AI });
    const result = await generateEmployeeChat(ai(env.ORCHESTRATOR_MODEL || DEFAULT_ORCHESTRATOR_MODEL), instructions, messages);
    if (!result.text || !["stop", "length"].includes(result.finishReason)) {
      return error(502, "Employee chat did not return a text completion.", "server_error");
    }
    return Response.json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }],
    }, { headers });
  } catch {
    return error(502, "Employee chat could not be completed.", "server_error");
  }
}
