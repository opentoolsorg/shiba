import type { Env } from "../env.js";
import { z } from "zod";

const coord = z.number().min(0).max(2000);
const delta = z.number().min(-2000).max(2000);
const input = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), x: coord, y: coord }),
  z.strictObject({ kind: z.literal("scroll"), x: coord, y: coord, deltaX: delta, deltaY: delta }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(2000) }),
  z.strictObject({ kind: z.literal("key"), key: z.enum([
    "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  ]) }),
]);
export const browserControlSchema = z.union([
  z.strictObject({ action: z.enum(["takeover", "handback", "stop"]) }),
  z.strictObject({ action: z.literal("input"), input }),
]);

export type BrowserControl = z.output<typeof browserControlSchema>;
export type BrowserCommand =
  | { kind: "open"; runId: string; url: string }
  | { kind: "read" | "close" | "end" }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "screenshot"; runId: string }
  | { kind: "frame"; actor: string }
  | { kind: "control"; actor: string; runId: string; control: BrowserControl }
  | { kind: "prepare-sign-in" | "sign-in"; loginId: string; actor: string; toolCallId: string };

export function chatBrowserKey(threadName: string) {
  return JSON.stringify(["chat", threadName]);
}

export class BrowserSessionError extends Error {}

export async function browserCommand<T>(env: Pick<Env, "BrowserSession">, key: string, command: BrowserCommand): Promise<T> {
  if (!env.BrowserSession) throw new BrowserSessionError("Live browser sessions are not configured.");
  const stub = env.BrowserSession.get(env.BrowserSession.idFromName(key));
  const response = await stub.fetch("https://browser-session.internal/command", { method: "POST", body: JSON.stringify(command) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new BrowserSessionError(body?.error ?? "Browser request failed.");
  }
  return response.json<T>();
}

export async function closeBrowserSession(env: Pick<Env, "BrowserSession">, threadName: string): Promise<void> {
  if (env.BrowserSession) await browserCommand(env, chatBrowserKey(threadName), { kind: "end" });
}
