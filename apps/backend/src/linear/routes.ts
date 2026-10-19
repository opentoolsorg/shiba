/**
 * POST /api/linear/webhook — Linear AgentSessionEvent ingress (signature optional in dev).
 */
import { automationsStub } from "../automations-stub.js";
import type { Env } from "./../env.js";
import { acknowledgeLinearSession, linearSessionId, shouldQueueLinearSession } from "./agent-session.js";
import {
  linearAutomationTask,
  linearSessionThreadKey,
  parseLinearAgentSessionPayload,
  verifyLinearWebhook,
} from "./webhook.js";

export const LINEAR_WEBHOOK_PATH = "/api/linear/webhook";

export async function handleLinearWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== LINEAR_WEBHOOK_PATH || request.method !== "POST") {
    return null;
  }
  const secret = env.LINEAR_WEBHOOK_SECRET?.trim() ?? "";
  const raw = await request.text();
  if (secret) {
    const sig = request.headers.get("linear-signature") ?? request.headers.get("x-linear-signature");
    if (!(await verifyLinearWebhook(raw, sig, secret))) {
      return Response.json({ error: "Invalid Linear webhook signature." }, { status: 401 });
    }
  } else if (!env.LINEAR_ALLOW_UNSIGNED_WEBHOOK) {
    return Response.json(
      { error: "Linear webhooks are not configured: set LINEAR_WEBHOOK_SECRET or LINEAR_ALLOW_UNSIGNED_WEBHOOK=1 for local mocks." },
      { status: 503 },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Webhook payload is not valid JSON." }, { status: 400 });
  }
  const event = parseLinearAgentSessionPayload(body);
  if (!event) {
    return Response.json({ error: "Unrecognized Linear agent session payload." }, { status: 400 });
  }
  const sessionId = linearSessionId(event);
  const waitUntil = ctx?.waitUntil?.bind(ctx);
  if (sessionId && shouldQueueLinearSession(event)) {
    waitUntil?.(
      acknowledgeLinearSession(env, sessionId).catch(() => {
        /* ack is best-effort */
      }),
    );
    waitUntil?.(
      automationsStub(env)
        .fetch(
          new Request("https://internal/internal/linear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event,
              sessionId,
              task: linearAutomationTask(event),
              teamKey: event.agentSession?.issue?.team?.key,
              repoUrl: env.LINEAR_DEFAULT_REPO_URL?.trim() ?? "",
            }),
          }),
        )
        .then((r) => {
          if (!r.ok) console.error(`automation linear fan-out failed: ${r.status}`);
        }),
    );
  }
  return Response.json({
    ok: true,
    action: event.action,
    sessionId,
    threadKey: sessionId ? linearSessionThreadKey(sessionId) : null,
  });
}
