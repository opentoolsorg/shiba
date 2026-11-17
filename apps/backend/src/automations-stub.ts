/**
 * The Automations DO stub + durable delivery dedupe, shared by the webhook
 * fan-outs and the cron tick. Extracted from index.ts (PLAN.md §18.0).
 */
import type { Env } from "./env.js";
import { automationsFor } from "./platform/do-resolver.js";

export function automationsStub(env: Env, workspaceId?: string) {
  // TODO(scope): pass authenticated workspace IDs at each automation ingress before enabling scoped DOs.
  return automationsFor(env, { workspaceId });
}

/** Durable check-and-record for a retried delivery id. True = already seen. */
export async function seenDelivery(env: Env, key: string): Promise<boolean> {
  const response = await automationsStub(env).fetch(
    new Request("https://internal/internal/dedupe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  );
  const body = (await response.json().catch(() => ({}))) as { seen?: boolean };
  return response.ok && body.seen === true;
}
