import type { Env } from "../env.js";
import { redactSecrets } from "../security.js";
import { browserCommand } from "./browser-sessions.js";
import { selectorRequiresSubmitApproval } from "./browser-url.js";

type BrowserEnv = Pick<Env, "BrowserSession">;

export function browserOpen(env: BrowserEnv, key: string, runId: string, url: string) {
  return browserCommand<{ sessionId: string; title: string; url: string }>(env, key, { kind: "open", runId, url });
}

export function browserRead(env: BrowserEnv, key: string) {
  return browserCommand<{ text: string; title: string; url: string }>(env, key, { kind: "read" });
}

export async function browserClick(env: BrowserEnv, key: string, selector: string, options?: { approved?: boolean }) {
  if (!options?.approved && selectorRequiresSubmitApproval(selector)) {
    throw new Error("browser_click requires human approval for submit-like selectors.");
  }
  return browserCommand<{ clicked: boolean; selector: string }>(env, key, { kind: "click", selector });
}

export async function browserType(env: BrowserEnv, key: string, selector: string, text: string, options?: { approved?: boolean }) {
  if (!options?.approved && selectorRequiresSubmitApproval(selector, text)) {
    throw new Error("browser_type requires human approval for password or submit fields.");
  }
  return browserCommand<{ typed: boolean; selector: string }>(env, key, { kind: "type", selector, text });
}

export function browserScreenshot(env: BrowserEnv, key: string, runId: string) {
  return browserCommand<{ key: string; url: null; bytes: number }>(env, key, { kind: "screenshot", runId });
}

export function browserToolError(error: unknown): { isError: true; message: string } {
  return { isError: true, message: redactSecrets(error instanceof Error ? error.message : String(error)) };
}
