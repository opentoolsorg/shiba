/**
 * Operator-facing integration probes (no outbound posts to Slack/Linear/GitHub).
 */
import type { Env } from "./env.js";
import { verifySlackRequest, SLACK_REPLAY_WINDOW_SECONDS } from "./slack.js";
import { isGitHubPublishConfigured } from "./github-auth.js";

export async function handleIntegrationsRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/integrations/slack/verify" && request.method === "POST") {
    const secret = env.SLACK_SIGNING_SECRET?.trim() ?? "";
    const sampleBody = JSON.stringify({ type: "url_verification", challenge: "shiba-verify-challenge" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const checks: Record<string, boolean | number | string> = {
      signingSecretConfigured: Boolean(secret),
      botTokenConfigured: Boolean(env.SLACK_BOT_TOKEN?.trim()),
      approverCount: (env.SLACK_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).length,
      replayWindowSeconds: SLACK_REPLAY_WINDOW_SECONDS,
    };
    if (secret) {
      const headers = new Headers({
        "x-slack-request-timestamp": timestamp,
      });
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`v0:${timestamp}:${sampleBody}`));
      const hex = Array.from(new Uint8Array(mac))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      headers.set("x-slack-signature", `v0=${hex}`);
      checks.signatureSelfTest = await verifySlackRequest(sampleBody, headers, secret);
    } else {
      checks.signatureSelfTest = false;
    }
    return Response.json({
      ok: true,
      liveVerified: false,
      note: "Self-test only — does not call Slack servers.",
      checks,
    });
  }
  if (url.pathname === "/api/integrations/github/status" && request.method === "GET") {
    return Response.json({
      ok: true,
      publishConfigured: isGitHubPublishConfigured(env),
      pat: Boolean(env.GITHUB_TOKEN?.trim()),
      app: Boolean(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim()),
      webhookSecret: Boolean(env.GITHUB_WEBHOOK_SECRET?.trim()),
      liveVerified: false,
    });
  }
  if (url.pathname === "/api/integrations/linear/status" && request.method === "GET") {
    return Response.json({
      ok: true,
      webhookSecret: Boolean(env.LINEAR_WEBHOOK_SECRET?.trim()),
      apiToken: Boolean(env.LINEAR_API_KEY?.trim() || env.LINEAR_OAUTH_ACCESS_TOKEN?.trim()),
      unsignedMockAllowed: env.LINEAR_ALLOW_UNSIGNED_WEBHOOK === "1",
      liveVerified: false,
    });
  }
  return null;
}
