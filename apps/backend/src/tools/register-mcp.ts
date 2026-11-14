import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "../env.js";
import type { ToolRegistry } from "../mcp-gateway.js";
import { registerAskUserTool } from "./ws08-ask-user.js";
import { registerKnowledgeSearchTool } from "./ws07-knowledge-search.js";
import { browserClick, browserOpen, browserRead, browserScreenshot, browserToolError, browserType } from "./browser.js";
import { generateImage } from "./image-gen.js";
import { runWebSearch, webSearchConfigured } from "./web-search.js";
import { DEFAULT_WEB_SEARCH_BUDGET, incrementToolUsage } from "./tool-usage-store.js";

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function runIdFromArgs(args: Record<string, unknown>, ctxRunId?: string): string {
  if (typeof args.runId === "string" && args.runId.trim()) return args.runId.trim();
  return ctxRunId?.trim() || "mcp-session";
}

/** Single MCP registration entry for WS10 agent media tools. */
export function registerAgentMediaMcpTools(registry: ToolRegistry, env: Env): void {
  registerKnowledgeSearchTool(registry, env);
  registerAskUserTool(registry, env);

  registry.registerTool(
    "web_search",
    "api:read",
    async (args, ctx) => {
      const orgId = ctx.principal.orgId ?? "self-hosted";
      const runId = runIdFromArgs(args, ctx.principal.principal);
      const budget = await incrementToolUsage(env, {
        orgId,
        runId,
        toolName: "web_search",
        budgetLimit: DEFAULT_WEB_SEARCH_BUDGET,
      });
      if (!budget.allowed) {
        return jsonResult({ ok: false, error: "Web search budget exceeded for this run." });
      }
      if (!webSearchConfigured(env)) {
        return jsonResult({ ok: false, unavailable: true, reason: "web search not configured" });
      }
      const query = String(args.query ?? "");
      const result = await runWebSearch(env, query);
      return jsonResult(result as unknown as Record<string, unknown>);
    },
    {
      description: "Search the public web and return titled URLs with snippets.",
      inputSchema: { query: z.string().min(1).max(500) },
      annotations: { readOnlyHint: true },
    },
  );

  const browserRunSchema = { runId: z.string().min(1).max(200).optional() };

  registry.registerTool(
    "browser_open",
    "api:read",
    async (args, ctx) => {
      try {
        const runId = runIdFromArgs(args, ctx.principal.principal);
        const opened = await browserOpen(env, runId, String(args.url ?? ""));
        return jsonResult({ ok: true, ...opened });
      } catch (error) {
        return jsonResult({ ok: false, ...browserToolError(error) });
      }
    },
    {
      description: "Open a URL in a per-run browser session (Workers Browser Rendering).",
      inputSchema: { ...browserRunSchema, url: z.string().url() },
      annotations: { readOnlyHint: false },
    },
  );

  registry.registerTool(
    "browser_read",
    "api:read",
    async (args, ctx) => {
      try {
        const runId = runIdFromArgs(args, ctx.principal.principal);
        const content = await browserRead(runId);
        return jsonResult({ ok: true, ...content });
      } catch (error) {
        return jsonResult({ ok: false, ...browserToolError(error) });
      }
    },
    {
      description: "Read visible text from the active browser session.",
      inputSchema: browserRunSchema,
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "browser_click",
    "sandbox:exec",
    async (args, ctx) => {
      try {
        const runId = runIdFromArgs(args, ctx.principal.principal);
        const selector = String(args.selector ?? "");
        const approved = args.approved === true;
        const clicked = await browserClick(runId, selector, { approved });
        return jsonResult({ ok: true, ...clicked });
      } catch (error) {
        return jsonResult({ ok: false, ...browserToolError(error) });
      }
    },
    {
      description: "Click an element in the active browser session. Submit-like selectors require approved=true.",
      inputSchema: { ...browserRunSchema, selector: z.string().min(1).max(500), approved: z.boolean().optional() },
      annotations: { readOnlyHint: false },
    },
  );

  registry.registerTool(
    "browser_type",
    "sandbox:exec",
    async (args, ctx) => {
      try {
        const runId = runIdFromArgs(args, ctx.principal.principal);
        const selector = String(args.selector ?? "");
        const text = String(args.text ?? "");
        const approved = args.approved === true;
        const typed = await browserType(runId, selector, text, { approved });
        return jsonResult({ ok: true, ...typed });
      } catch (error) {
        return jsonResult({ ok: false, ...browserToolError(error) });
      }
    },
    {
      description: "Type into an element. Password/submit fields require approved=true.",
      inputSchema: {
        ...browserRunSchema,
        selector: z.string().min(1).max(500),
        text: z.string().max(2000),
        approved: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
  );

  registry.registerTool(
    "browser_screenshot",
    "api:read",
    async (args, ctx) => {
      try {
        const runId = runIdFromArgs(args, ctx.principal.principal);
        const shot = await browserScreenshot(env, runId);
        return jsonResult({ ok: true, ...shot });
      } catch (error) {
        return jsonResult({ ok: false, ...browserToolError(error) });
      }
    },
    {
      description: "Capture a PNG screenshot from the active session into Outputs.",
      inputSchema: browserRunSchema,
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "generate_image",
    "api:write",
    async (args, ctx) => {
      const runId = runIdFromArgs(args, ctx.principal.principal);
      const prompt = String(args.prompt ?? "");
      const aspect = args.aspect === "landscape" || args.aspect === "portrait" ? args.aspect : "square";
      const result = await generateImage(env, { prompt, aspect, runId });
      return jsonResult(result as unknown as Record<string, unknown>);
    },
    {
      description: "Generate a PNG with Workers AI FLUX and store it in Outputs.",
      inputSchema: {
        ...browserRunSchema,
        prompt: z.string().min(1).max(2000),
        aspect: z.enum(["square", "landscape", "portrait"]).optional(),
      },
      annotations: { readOnlyHint: false },
    },
  );
}