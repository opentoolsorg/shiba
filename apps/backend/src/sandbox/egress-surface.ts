/**
 * Static egress maps formerly on the 0.12 Sandbox class — kept for tests and
 * docs that reference the allowlist layout without loading a Durable Object.
 */
import {
  denyUnscopedGitHub,
  forwardAnthropic,
  forwardClaudeSubscription,
  forwardCodexSubscription,
  forwardCursorSubscription,
  forwardDevinApi,
  forwardDevinInference,
  forwardDevinSubscription,
  forwardGitHubScoped,
  forwardGoogle,
  forwardOpenAI,
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
  cursorSubscription: forwardCursorSubscription,
  devinSubscription: forwardDevinSubscription,
};

export const outboundByHost: Record<string, HostHandler> = {
  "generativelanguage.googleapis.com": forwardGoogle,
  "api.anthropic.com": forwardAnthropic,
  "api.openai.com": forwardOpenAI,
  "api.x.ai": forwardXAI,
  "opencode.ai": forwardOpenCodeGo,
  "api.devin.ai": forwardDevinApi,
  "server.codeium.com": forwardDevinInference,
  "github.com": denyUnscopedGitHub,
};
