/**
 * Static egress maps formerly on the 0.12 Sandbox class — kept for tests and
 * docs that reference the allowlist layout without loading a Durable Object.
 */
import {
  denyUnscopedGitHub,
  forwardAnthropic,
  forwardClaudeSubscription,
  forwardCodexPlan,
  forwardCodexSubscription,
  forwardCursorSubscription,
  forwardGitHubScoped,
  forwardGoogle,
  forwardOpenAI,
  forwardOpenRouter,
  forwardGroq,
  forwardCopilot,
  forwardKimi,
  forwardMeta,
  forwardZai,
  forwardMiniMax,
  forwardQwen,
  forwardMistral,
  forwardOpenCodeGo,
  forwardXAI,
  type EgressEnv,
  type OutboundHandlerCtx,
} from "../egress.js";

type HostHandler = (request: Request, env: EgressEnv, ctx?: OutboundHandlerCtx) => Promise<Response>;

export const INACTIVITY_TIMEOUT_MS = 60_000;

export const outboundHandlers: Record<string, HostHandler> = {
  githubScoped: forwardGitHubScoped,
  claudeSubscription: forwardClaudeSubscription,
  codexSubscription: forwardCodexSubscription,
  codexPlan: forwardCodexPlan,
  cursorSubscription: forwardCursorSubscription,
};

export const outboundByHost: Record<string, HostHandler> = {
  "generativelanguage.googleapis.com": forwardGoogle,
  "api.anthropic.com": forwardAnthropic,
  "api.openai.com": forwardOpenAI,
  "openrouter.ai": forwardOpenRouter,
  "api.groq.com": forwardGroq,
  "api.githubcopilot.com": forwardCopilot,
  "api.kimi.ai": forwardKimi,
  "api.meta.ai": forwardMeta,
  "api.z.ai": forwardZai,
  "api.minimax.io": forwardMiniMax,
  "dashscope-intl.aliyuncs.com": forwardQwen,
  "api.mistral.ai": forwardMistral,
  "api.x.ai": forwardXAI,
  "opencode.ai": forwardOpenCodeGo,
  "github.com": denyUnscopedGitHub,
};
