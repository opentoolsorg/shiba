/**
 * `/api/github/webhook` — HMAC-verified GitHub deliveries, deduped through
 * the Automations DO, then fanned out under waitUntil. Extracted from
 * index.ts.
 */
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";
import { redactSecrets, verifyGitHubWebhookSignature } from "./security.js";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleGitHubWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/github/webhook" || request.method !== "POST") {
    return null;
  }
  const secret = env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: "Webhooks are not configured: set the GITHUB_WEBHOOK_SECRET secret." },
      { status: 503 },
    );
  }
  const payload = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const valid = await verifyGitHubWebhookSignature({ secret, payload, signature });
  if (!valid) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  let event: unknown = null;
  try {
    event = JSON.parse(payload);
  } catch {
    return Response.json({ error: "Webhook payload is not valid JSON." }, { status: 400 });
  }
  // Delivery dedupe sits after HMAC verification (an unauthenticated request
  // must never write dedupe keys) and before fan-out. The HMAC covers only the
  // body — a replayed signed body with a new or absent delivery header must
  // still be refused, so the header is REQUIRED and dedupe records BOTH the
  // delivery id and the payload hash: a reused id OR a reused signed body is
  // a replay. Fail closed on dedupe errors: a transient 503 gets a GitHub
  // retry; a duplicate automation run is a silent side effect.
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) {
    return Response.json({ error: "Missing X-GitHub-Delivery header." }, { status: 400 });
  }
  const payloadHash = await sha256Hex(payload);
  try {
    const stub = automationsStub(env);
    const check = async (key: string): Promise<boolean> => {
      const response = await stub.fetch(
        new Request("https://internal/internal/dedupe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        }),
      );
      if (!response.ok) {
        throw new Error(`dedupe endpoint returned ${response.status}`);
      }
      const body = (await response.json().catch(() => ({}))) as { seen?: boolean };
      return body.seen === true;
    };
    if (await check(`gh-delivery:${deliveryId}`)) {
      return Response.json({ ok: true, deduped: true });
    }
    if (await check(`gh-payload:${payloadHash}`)) {
      return Response.json({ ok: true, deduped: true });
    }
  } catch (error: unknown) {
    console.error(
      `github delivery dedupe failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return Response.json({ error: "Delivery dedupe unavailable; retry." }, { status: 503 });
  }
  const githubEvent = request.headers.get("x-github-event") ?? "unknown";
  const action = typeof event === "object" && event !== null
    ? (event as { action?: unknown }).action
    : undefined;
  const waitUntil = ctx?.waitUntil?.bind(ctx);
  if (waitUntil) {
    waitUntil(
      automationsStub(env)
        .fetch(
          new Request("https://internal/internal/github", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: githubEvent, payload: event, deliveryId }),
          }),
        )
        .then((response) => {
          if (!response.ok) {
            console.error(`automation github fan-out failed: ${response.status}`);
          }
        })
        .catch((error: unknown) => {
          console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
        }),
    );
  }
  return Response.json({
    ok: true,
    event: githubEvent,
    action: typeof action === "string" ? action : null,
  });
}
