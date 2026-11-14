export type EmailTemplateKind =
  | "verification"
  | "bootstrap_verification"
  | "password_reset"
  | "workspace_invitation";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export type EmailTemplateMeta = Record<string, string>;