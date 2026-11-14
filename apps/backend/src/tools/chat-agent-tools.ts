import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env.js";
import { browserClick, browserOpen, browserRead, browserScreenshot, browserType } from "./browser.js";
import { generateImage } from "./image-gen.js";
import { runWebSearch, webSearchConfigured } from "./web-search.js";
import { DEFAULT_WEB_SEARCH_BUDGET, incrementToolUsage } from "./tool-usage-store.js";
import { selectorRequiresSubmitApproval } from "./browser-url.js";
import { closeBrowserSession } from "./browser-sessions.js";

export interface ChatAgentToolsContext {
  runId: string;
  orgId?: string;
  onClose?: () => void;
}

/** AI SDK tools for chat-mode orchestrator turns (media + browser). */
export function createChatAgentMediaTools(env: Env, ctx: ChatAgentToolsContext): ToolSet {
  const orgId = ctx.orgId ?? "self-hosted";
  const runId = ctx.runId;

  return {
    web_search: tool({
      description: "Search the public web. Returns title, URL, and snippet for each result.",
      inputSchema: z.object({ query: z.string().min(1).max(500) }),
      execute: async ({ query }) => {
        if (!webSearchConfigured(env)) {
          return { ok: false, unavailable: true, message: "Web search is not configured on this deployment." };
        }
        const budget = await incrementToolUsage(env, { orgId, runId, toolName: "web_search", budgetLimit: DEFAULT_WEB_SEARCH_BUDGET });
        if (!budget.allowed) return { ok: false, error: "Web search budget exceeded for this conversation." };
        return runWebSearch(env, query);
      },
    }),
    browser_open: tool({
      description: "Open a URL in a browser session tied to this chat run.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => browserOpen(env, runId, url),
    }),
    browser_read: tool({
      description: "Read readable text from the current browser session.",
      inputSchema: z.object({}).strict(),
      execute: async () => browserRead(runId),
    }),
    browser_click: tool({
      description: "Click a CSS selector in the browser session. Submit buttons require approval.",
      inputSchema: z.object({ selector: z.string().min(1).max(500) }),
      needsApproval: async ({ selector }) => selectorRequiresSubmitApproval(selector),
      execute: async ({ selector }) => browserClick(runId, selector, {
        approved: selectorRequiresSubmitApproval(selector),
      }),
    }),
    browser_type: tool({
      description: "Type text into a focused element. Password fields require approval.",
      inputSchema: z.object({ selector: z.string().min(1).max(500), text: z.string().max(2000) }),
      needsApproval: async ({ selector, text }) => selectorRequiresSubmitApproval(selector, text),
      execute: async ({ selector, text }) => browserType(runId, selector, text, {
        approved: selectorRequiresSubmitApproval(selector, text),
      }),
    }),
    browser_screenshot: tool({
      description: "Save a PNG screenshot from the browser session to Outputs.",
      inputSchema: z.object({}).strict(),
      execute: async () => browserScreenshot(env, runId),
    }),
    generate_image: tool({
      description: "Generate an image from a prompt using Workers AI FLUX.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(2000),
        aspect: z.enum(["square", "landscape", "portrait"]).optional(),
      }),
      execute: async ({ prompt, aspect }) => generateImage(env, { prompt, aspect, runId }),
    }),
    browser_close: tool({
      description: "Close the browser session for this chat run.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        await closeBrowserSession(runId);
        ctx.onClose?.();
        return { closed: true };
      },
    }),
  };
}