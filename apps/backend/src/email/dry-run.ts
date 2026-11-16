import type { Env } from "../env.js";
import { audit } from "../audit.js";

/** The only transport allowed to print a full reset link; preview opt-in only. */
export async function recordDryRunEmail(
  env: Env,
  message: { to: string; subject: string; url?: string },
): Promise<void> {
  let redactedLink: string | undefined;
  if (message.url) {
    const url = new URL(message.url);
    // Retain only the destination and a short token hint, never other query data.
    const pathToken = url.pathname.match(/^(\/api\/auth\/reset-password\/)([^/]+)$/);
    const token = url.searchParams.get("token") ?? pathToken?.[2] ?? "";
    const path = pathToken ? `${pathToken[1]}${token.slice(0, 6)}…` : url.pathname;
    redactedLink = `${url.origin}${path}${token && !pathToken ? `?token=${token.slice(0, 6)}…` : ""}`;
  }
  const detail = JSON.stringify({ to: message.to, subject: message.subject, link: redactedLink });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(detail));
  await audit(env, {
    principal: "email-transport",
    tool: "email.dry_run",
    argsHash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    outcome: "ok",
    detail,
  });
  if (env.SHIBA_EMAIL_DRY_RUN_LOG_LINKS === "1" && message.url) {
    console.log(`Email dry-run link: ${message.url}`);
  }
}
