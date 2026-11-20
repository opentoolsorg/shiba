import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env.js";
import { browserClick, browserOpen, browserRead, browserScreenshot, browserType } from "./browser.js";
import { generateVideo, videoCapability, videoInputSchema } from "./video-gen.js";
import { generateImage } from "./image-gen.js";
import { imageInputSchema } from "./image-models.js";
import { pageInputSchema, reportInputSchema, saveGeneratedDocument } from "./document-gen.js";
import { WEB_SEARCH_DESCRIPTION, runWebSearch, webSearchConfigured, webSearchInputSchema, webSearchQueries } from "./web-search.js";
import { DEFAULT_WEB_SEARCH_BUDGET, incrementToolUsage } from "./tool-usage-store.js";
import { selectorRequiresSubmitApproval } from "./browser-url.js";
import { knowledgeSearchToolArgsSchema } from "@shiba/shared";
import { knowledgeSearchConfigured } from "../knowledge/knowledge-tool.js";
import { hybridKnowledgeSearch } from "../knowledge/knowledge-search.js";
import { browserCommand, chatBrowserKey } from "./browser-sessions.js";
import { loginIdSchema } from "./browser-logins.js";

export interface ChatAgentToolsContext {
  runId: string;
  orgId?: string;
  userId?: string;
  /**
   * Budget window for paid lookups. The caller passes one per user message:
   * a thread-wide key would let two batches exhaust search for its lifetime.
   */
  budgetKey?: string;
  canUseBrowserLogins?: () => Promise<boolean>;
}

/** AI SDK tools for chat-mode orchestrator turns (media + browser). */
export function createChatAgentMediaTools(env: Env, ctx: ChatAgentToolsContext): ToolSet {
  const orgId = ctx.orgId ?? "self-hosted";
  const runId = ctx.runId;
  const userId = ctx.userId;
  const budgetKey = ctx.budgetKey ?? runId;
  const browserKey = chatBrowserKey(runId);

  return {
    web_search: tool({
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: webSearchInputSchema,
      execute: async (input) => {
        if (!webSearchConfigured(env)) {
          return { ok: false, unavailable: true, message: "Web search is not configured on this deployment." };
        }
        const budget = await incrementToolUsage(env, {
          orgId, runId: budgetKey, toolName: "web_search", budgetLimit: DEFAULT_WEB_SEARCH_BUDGET, calls: webSearchQueries(input).length,
        });
        if (!budget.allowed) return { ok: false, error: "Web search budget exceeded for this message." };
        return runWebSearch(env, input);
      },
    }),
    ...(userId ? {
      knowledge_search: tool({
        // Chat runs in the deployment's own scope: a dashboard session's files and
        // notes are personal to their owner, so say that instead of implying team access.
        description: "Search the user's own files and notes (their personal scope, never a team workspace). " +
          "Returns ranked passages with the source name; cite it when you use a passage.",
        inputSchema: knowledgeSearchToolArgsSchema,
        execute: async ({ query, limit }) => {
          if (!knowledgeSearchConfigured(env)) {
            return { ok: false, unavailable: true, message: "Knowledge search is not provisioned on this deployment." };
          }
          return { ok: true, query, hits: await hybridKnowledgeSearch(env, userId, orgId.replace(/^team:/, ""), query, limit ?? 8) };
        },
      }),
    } : {}),
    ...(ctx.canUseBrowserLogins ? {
      browser_open: tool({
        description: "Open a URL in a browser session tied to this chat run.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => browserOpen(env, browserKey, runId, url),
      }),
      browser_read: tool({
        description: "Read readable text from the current browser session.",
        inputSchema: z.object({}).strict(),
        execute: async () => browserRead(env, browserKey),
      }),
      browser_click: tool({
        description: "Click a CSS selector in the browser session. Submit buttons require approval.",
        inputSchema: z.object({ selector: z.string().min(1).max(500) }),
        needsApproval: async ({ selector }) => selectorRequiresSubmitApproval(selector),
        execute: async ({ selector }) => browserClick(env, browserKey, selector, {
          approved: selectorRequiresSubmitApproval(selector),
        }),
      }),
      browser_type: tool({
        description: "Type text into a focused element. Password fields require approval.",
        inputSchema: z.object({ selector: z.string().min(1).max(500), text: z.string().max(2000) }),
        needsApproval: async ({ selector, text }) => selectorRequiresSubmitApproval(selector, text),
        execute: async ({ selector, text }) => browserType(env, browserKey, selector, text, {
          approved: selectorRequiresSubmitApproval(selector, text),
        }),
      }),
      browser_screenshot: tool({
        description: "Save a PNG screenshot from the browser session to Outputs.",
        inputSchema: z.object({}).strict(),
        execute: async () => browserScreenshot(env, browserKey, runId),
      }),
      browser_sign_in: tool({
        description: "Use a saved login by ID on its exact HTTPS origin. Always asks the signed-in person to approve this use. Never ask the user to paste credentials into chat.",
        inputSchema: z.strictObject({ loginId: loginIdSchema }),
        needsApproval: async ({ loginId }, { toolCallId }) => {
          if (!userId || !await ctx.canUseBrowserLogins?.()) throw new Error("Saved browser sign-in requires a signed-in dashboard thread.");
          await browserCommand(env, browserKey, { kind: "prepare-sign-in", actor: userId, loginId, toolCallId });
          return true;
        },
        execute: async ({ loginId }, { toolCallId }) => {
          if (!userId || !await ctx.canUseBrowserLogins?.()) throw new Error("Saved browser sign-in requires a signed-in dashboard thread.");
          return browserCommand<{ signedIn: boolean; url: string; loginLabel: string }>(env, browserKey, {
            kind: "sign-in", actor: userId, loginId, toolCallId,
          });
        },
      }),
      browser_close: tool({
        description: "Close the browser session for this chat run.",
        inputSchema: z.object({}).strict(),
        execute: async () => browserCommand<{ closed: boolean }>(env, browserKey, { kind: "close" }),
      }),
    } : {}),
    ...(videoCapability(env).enabled && userId ? {
      generate_video: tool({
        description: "Generate a paid short MP4 from text or your image artifact. Requires human confirmation before spending.",
        inputSchema: videoInputSchema,
        needsApproval: true,
        execute: async (input) => generateVideo(env, input, { runId, userId, workspaceId: orgId.replace(/^team:/, "") }),
      }),
    } : {}),
    generate_image: tool({
      description: "Generate an image from a prompt with a chosen style and shape.",
      inputSchema: imageInputSchema,
      execute: async (input) => generateImage(env, { ...input, runId, userId, workspaceId: orgId.replace(/^team:/, "") }),
    }),
    ...(userId && env.AGENT_AUDIT && (env.FILES || env.ARTIFACTS) ? {
      generate_report: tool({
        description: "Save a long-form Markdown report you wrote, with the sources you used, as a private file the user can read and download.",
        inputSchema: reportInputSchema,
        execute: async (input) => saveGeneratedDocument(env, "report", input, { runId, userId, workspaceId: orgId.replace(/^team:/, "") }),
      }),
      generate_page: tool({
        description: "Save a self-contained static HTML page you wrote (inline CSS only, no scripts or remote resources) as a private file the user can preview and download.",
        inputSchema: pageInputSchema,
        execute: async (input) => saveGeneratedDocument(env, "page", input, { runId, userId, workspaceId: orgId.replace(/^team:/, "") }),
      }),
    } : {}),
  };
}
