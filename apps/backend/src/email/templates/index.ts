import type { EmailTemplateKind, EmailTemplateMeta, RenderedEmail } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapHtml(body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">${body}</body></html>`;
}

export function renderEmailTemplate(kind: EmailTemplateKind, meta: EmailTemplateMeta): RenderedEmail {
  const url = meta.url ?? "";
  switch (kind) {
    case "verification":
      return {
        subject: "Verify your email to join Shiba",
        text: `You requested an account through a Shiba workspace invitation. Verify your email using this link:\n\n${url}\n\nThe link expires in one hour. Verification does not grant deployment administration or join a workspace automatically. If you did not request this account, ignore this email.`,
        html: wrapHtml(
          `<p>Verify your email to continue with Shiba.</p><p><a href="${escapeHtml(url)}">Verify email</a></p><p>If you did not request this, ignore this message.</p>`,
        ),
      };
    case "bootstrap_verification":
      return {
        subject: "Verify your Shiba dashboard email",
        text: `You requested verification of your existing Shiba dashboard email. Open this link, then choose Confirm email:\n\n${url}\n\nThe link expires in one hour. Verification does not create an account, sign you in, or change your existing permissions. If you did not request it, ignore this email.`,
        html: wrapHtml(
          `<p>Confirm your dashboard email.</p><p><a href="${escapeHtml(url)}">Open verification</a></p>`,
        ),
      };
    case "password_reset":
      return {
        subject: "Reset your Shiba password",
        text: `You requested a password reset for your Shiba dashboard account. Use this link:\n\n${url}\n\nThe link expires in one hour. If you did not request a reset, ignore this email and your password will stay the same.`,
        html: wrapHtml(
          `<p>Reset your password.</p><p><a href="${escapeHtml(url)}">Reset password</a></p>`,
        ),
      };
    case "workspace_invitation": {
      const workspace = meta.workspaceName ?? "a workspace";
      return {
        subject: `Invitation to join ${workspace} on Shiba`,
        text: `You were invited to join ${workspace} on Shiba.\n\nAccept the invitation:\n\n${url}\n\nThe link expires in seven days. You must sign in or create an account with this exact email address before accepting.`,
        html: wrapHtml(
          `<p>You were invited to join <strong>${escapeHtml(workspace)}</strong>.</p><p><a href="${escapeHtml(url)}">Accept invitation</a></p>`,
        ),
      };
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown email template: ${String(_exhaustive)}`);
    }
  }
}

export type { EmailTemplateKind, EmailTemplateMeta, RenderedEmail } from "./types.js";