import type { Env } from "./env.js";
import { enqueueTransactionalEmail } from "./email/outbox.js";

async function requireDelivered(env: Env, outboxId: string | null): Promise<void> {
  if (!outboxId || !env.AGENT_AUDIT) throw new Error("Transactional email delivery failed.");
  const row = await env.AGENT_AUDIT.prepare("SELECT status FROM email_outbox WHERE outbox_id = ?")
    .bind(outboxId)
    .first<{ status: string }>();
  if (!row || row.status !== "sent") throw new Error("Transactional email delivery failed.");
}

/** Dedicated transactional sender. Employee draft send authority is not reused. */
export function nativeEnrollmentEmailConfiguration(env: Env): { from: string; origin: string } | null {
  const from = env.BETTER_AUTH_VERIFICATION_FROM?.trim() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Rejects control bytes in untrusted identity or portable text input.
  if (!/^[^\s@\x00-\x1f<>]+@[^\s@\x00-\x1f<>]+\.[^\s@\x00-\x1f<>]+$/.test(from) || !env.SEND_EMAIL) return null;
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return { from, origin: url.origin };
  } catch { return null; }
}

export async function sendNativeEnrollmentVerification(env: Env, input: { email: string; url: string }): Promise<void> {
  const config = nativeEnrollmentEmailConfiguration(env);
  if (!config) throw new Error("Invitation enrollment requires a verified sender, SEND_EMAIL, and an HTTPS BETTER_AUTH_URL.");
  const url = new URL(input.url);
  if (url.origin !== config.origin || url.pathname !== "/api/auth/verify-email" || url.username || url.password) {
    throw new Error("Invalid email verification destination.");
  }
  await enqueueTransactionalEmail(env, {
    kind: "verification",
    to: input.email,
    meta: { url: url.href },
  });
}

/** Explicit owner request only. The token is a fragment, never an HTTP query. */
export async function sendNativeBootstrapVerification(env: Env, input: { email: string; url: string }): Promise<void> {
  const config = nativeEnrollmentEmailConfiguration(env);
  if (!config) throw new Error("Bootstrap verification requires a configured verified email sender.");
  const url = new URL(input.url), fragment = new URLSearchParams(url.hash.slice(1));
  if (url.origin !== config.origin || url.pathname !== "/app/" || url.search !== "?verify=bootstrap" || url.username || url.password ||
    [...fragment.keys()].length !== 1 || !fragment.get("bootstrapVerification")) throw new Error("Invalid bootstrap verification destination.");
  const outboxId = await enqueueTransactionalEmail(env, {
    kind: "bootstrap_verification",
    to: input.email,
    meta: { url: url.href },
  });
  await requireDelivered(env, outboxId);
}

export async function sendNativePasswordReset(env: Env, input: { email: string; url: string }): Promise<void> {
  const config = nativeEnrollmentEmailConfiguration(env);
  if (!config) throw new Error("Password reset requires a verified sender, SEND_EMAIL, and an HTTPS BETTER_AUTH_URL.");
  const url = new URL(input.url);
  if (url.origin !== config.origin || url.username || url.password) {
    throw new Error("Invalid password reset destination.");
  }
  await enqueueTransactionalEmail(env, {
    kind: "password_reset",
    to: input.email,
    meta: { url: url.href },
  });
}

export async function sendWorkspaceInvitationEmail(
  env: Env,
  input: { email: string; token: string; workspaceName: string },
): Promise<void> {
  const config = nativeEnrollmentEmailConfiguration(env);
  if (!config) return;
  const url = new URL("/app/", config.origin);
  url.hash = `invite=${input.token}`;
  await enqueueTransactionalEmail(env, {
    kind: "workspace_invitation",
    to: input.email,
    meta: { url: url.href, workspaceName: input.workspaceName },
  });
}