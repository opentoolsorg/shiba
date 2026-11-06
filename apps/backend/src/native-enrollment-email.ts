import type { Env } from "./env.js";

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
  // URL and recipient are deliberately absent from logs and responses.
  await env.SEND_EMAIL!.send({ from: config.from, to: input.email,
    subject: "Verify your email to join Shiba",
    text: `You requested an account through a Shiba workspace invitation. Verify your email using this link:\n\n${url.href}\n\nThe link expires in one hour. Verification does not grant deployment administration or join a workspace automatically. If you did not request this account, ignore this email.` });
}

/** Explicit owner request only. The token is a fragment, never an HTTP query. */
export async function sendNativeBootstrapVerification(env: Env, input: { email: string; url: string }): Promise<void> {
  const config = nativeEnrollmentEmailConfiguration(env);
  if (!config) throw new Error("Bootstrap verification requires a configured verified email sender.");
  const url = new URL(input.url), fragment = new URLSearchParams(url.hash.slice(1));
  if (url.origin !== config.origin || url.pathname !== "/app/" || url.search !== "?verify=bootstrap" || url.username || url.password ||
    [...fragment.keys()].length !== 1 || !fragment.get("bootstrapVerification")) throw new Error("Invalid bootstrap verification destination.");
  await env.SEND_EMAIL!.send({ from: config.from, to: input.email,
    subject: "Verify your Shiba dashboard email",
    text: `You requested verification of your existing Shiba dashboard email. Open this link, then choose Confirm email:\n\n${url.href}\n\nThe link expires in one hour. Verification does not create an account, sign you in, or change your existing permissions. If you did not request it, ignore this email.` });
}
