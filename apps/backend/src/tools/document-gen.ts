import { z } from "zod";
import type { Env } from "../env.js";
import { insertFileRecord } from "../files/files-store.js";

/** Storage prefix that marks a file as a Chat-generated report or page; Outputs and the preview route rely on it. */
export const GENERATED_DOCUMENT_PREFIX = "generated-documents/";
export const MAX_DOCUMENT_BYTES = 128 * 1024;

export type DocumentKind = "report" | "page";
export type GeneratedDocumentResult =
  | { ok: true; kind: DocumentKind; title: string; artifactId: string; mime: string; bytes: number; downloadPath: string; previewPath?: string; sourceCount?: number }
  | { ok: false; error: string };

const oneLine = (value: string) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const titleSchema = z.string().trim().min(1, "Give it a one-line title.").max(160, "Keep the title under 160 characters.").refine(oneLine, "Use a one-line title.");
const sourceSchema = z.object({
  title: z.string().trim().min(1).max(200).refine(oneLine, "Use a one-line source title."),
  url: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    } catch { return false; }
  }, "Source links must be http or https addresses.").optional(),
}).strict();

export const reportInputSchema = z.object({
  title: titleSchema.describe("Report title, one line."),
  markdown: z.string().min(1).max(MAX_DOCUMENT_BYTES).describe("The full report in Markdown, citing sources as [1], [2]."),
  sources: z.array(sourceSchema).max(32).optional().describe("Only the sources actually used, in citation order."),
}).strict();

export const pageInputSchema = z.object({
  title: titleSchema.describe("Page title, one line."),
  html: z.string().min(1).max(MAX_DOCUMENT_BYTES).describe("One self-contained static HTML document with inline CSS only."),
}).strict();

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const activeMarkup: Array<[RegExp, string]> = [
  [/<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|portal|form|input|button|textarea|select|base|link|meta)\b/i, "script, embed, form, link, base and meta elements"],
  [/\son[a-z]+\s*=/i, "event handler attributes"],
  [/(javascript|vbscript)\s*:/i, "javascript: links"],
  [/@import\b/i, "@import"],
  [/url\(\s*(?!["']?\s*data:)/i, "url() references other than data: images"],
  [/\b(src|srcset|poster|data|action|formaction|xlink:href)\s*=\s*(?!["']?\s*data:)/i, "external sources (use data: images)"],
];

/** Static pages only: anything that could run code, load remote content or submit data is refused with a fixable message. */
export function unsafePageMarkup(html: string): string | null {
  const found = activeMarkup.filter(([pattern]) => pattern.test(html)).map(([, label]) => label);
  return found.length ? `Make the page static: remove ${found.join(", ")}.` : null;
}

function withPagePolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? html.slice(0, doctype[0].length) + meta + html.slice(doctype[0].length) : meta + html;
}

function withSources(markdown: string, sources: Array<z.infer<typeof sourceSchema>>): string {
  if (!sources.length) return markdown;
  const escape = (value: string) => value.replace(/[\\[\]()*_`<>]/g, (char) => `\\${char}`);
  const list = sources.map((source, index) => `${index + 1}. ${source.url ? `[${escape(source.title)}](${encodeURI(source.url)})` : escape(source.title)}`);
  return `${markdown.trimEnd()}\n\n## Sources\n\n${list.join("\n")}\n`;
}

function fileName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
  return `${base}.${extension}`;
}

/** Saves a model-written report or page as a private file of the requesting user; no provider call and no sandbox. */
export async function saveGeneratedDocument(
  env: Env,
  kind: DocumentKind,
  raw: unknown,
  context: { runId: string; userId?: string; workspaceId?: string },
): Promise<GeneratedDocumentResult> {
  const parsed = kind === "report" ? reportInputSchema.safeParse(raw) : pageInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? `Use a one-line title and a ${kind} under 128 KB.` };
  const bucket = env.FILES ?? env.ARTIFACTS;
  if (!context.userId || !context.workspaceId || !env.AGENT_AUDIT || !bucket) return { ok: false, error: "Saving reports and pages needs a signed-in user and file storage." };
  const { title } = parsed.data;
  let text: string;
  let sourceCount: number | undefined;
  if ("markdown" in parsed.data) {
    if (!parsed.data.markdown.trim()) return { ok: false, error: "The report is empty." };
    const sources = parsed.data.sources ?? [];
    text = withSources(parsed.data.markdown, sources);
    sourceCount = sources.length;
  } else {
    const unsafe = unsafePageMarkup(parsed.data.html);
    if (unsafe) return { ok: false, error: unsafe };
    text = withPagePolicy(parsed.data.html);
  }
  if (text.includes("\u0000")) return { ok: false, error: `The ${kind} contains a null character.` };
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, error: `Keep the ${kind} under 128 KB.` };
  const extension = kind === "report" ? "md" : "html";
  const mime = kind === "report" ? "text/markdown" : "text/html";
  const key = `${GENERATED_DOCUMENT_PREFIX}${encodeURIComponent(context.workspaceId)}/${crypto.randomUUID()}.${extension}`;
  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType: `${mime}; charset=utf-8` }, customMetadata: { kind: "output", runId: context.runId } });
  } catch {
    return { ok: false, error: `Your ${kind} could not be saved. Please try again.` };
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const file = await insertFileRecord(env, {
      workspaceId: context.workspaceId, scope: "personal", name: fileName(title, extension), mime,
      size: bytes.byteLength, r2Key: key, sha256, createdBy: context.userId, ingestionState: "done",
    });
    const downloadPath = `/api/files/${file.id}/download`;
    return kind === "report"
      ? { ok: true, kind, title, artifactId: file.id, mime, bytes: bytes.byteLength, downloadPath, sourceCount }
      : { ok: true, kind, title, artifactId: file.id, mime, bytes: bytes.byteLength, downloadPath, previewPath: `/api/files/${file.id}/preview` };
  } catch {
    await env.AGENT_AUDIT.prepare("DELETE FROM files WHERE r2_key=? AND created_by=?").bind(key, context.userId).run().catch(() => {});
    await bucket.delete(key).catch(() => {});
    return { ok: false, error: `Your ${kind} could not be saved. Please try again.` };
  }
}
