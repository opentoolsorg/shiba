import { botLibraryFileIds, type CustomAgentConfig } from "@shiba/shared";
import type { CustomAgentWire } from "./components/CustomAgentsView";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

export const MAX_BOT_DELIVERABLES = 8;
export { botLibraryFileIds };

/** A bot-panel edit: `null` clears the field, `undefined` leaves it alone. */
export interface BotConfigEdit {
  instructions?: string;
  codingModel?: string | null;
  libraryFileIds?: readonly string[] | null;
}

/**
 * A bot's library is its linked documents plus its required deliverables.
 * A linked document is stored as a knowledge file id, never a copy, so opening
 * it re-runs the file route's own permission check. Attaching, removing or
 * retargeting a row is a versioned config edit — never a file upload and never a
 * silent change to an approval already in flight.
 */
export function botConfigWithEdit(config: CustomAgentConfig, edit: BotConfigEdit): CustomAgentConfig {
  const next: CustomAgentConfig = { ...config };
  if (edit.instructions !== undefined) next.instructions = edit.instructions;
  if (edit.codingModel !== undefined) {
    if (edit.codingModel) next.codingModel = edit.codingModel;
    else delete next.codingModel;
  }
  if (edit.libraryFileIds !== undefined) {
    const ids = [...new Set((edit.libraryFileIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (ids.length) next.libraryFileIds = ids;
    else delete next.libraryFileIds;
  }
  return next;
}

async function patchBotConfig(agent: CustomAgentWire, config: CustomAgentConfig, workspaceId?: string): Promise<CustomAgentWire> {
  const response = await fetch(`/api/custom-agents/${encodeURIComponent(agent.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
    body: JSON.stringify({ config, expectedVersion: agent.version }),
  });
  const body = (await response.json().catch(() => ({}))) as { agent?: CustomAgentWire; error?: string };
  if (response.status === 409) {
    throw new Error("This bot changed since it was opened. Reload the latest version before saving.");
  }
  if (response.status === 404) {
    throw new Error("This bot is no longer in this workspace. Reload to see the current directory.");
  }
  if (!response.ok || !body.agent) {
    throw new Error(body.error ?? `Could not save this bot (${response.status}).`);
  }
  return body.agent;
}

/** Persists one bot's config edit and returns the stored version. */
export async function saveBotConfig(agent: CustomAgentWire, edit: BotConfigEdit, workspaceId?: string): Promise<CustomAgentWire> {
  return patchBotConfig(agent, botConfigWithEdit(agent.config, edit), workspaceId);
}

export async function saveBotDeliverables(
  agent: CustomAgentWire,
  deliverables: readonly string[],
  workspaceId?: string,
): Promise<CustomAgentWire> {
  const cleaned = [...new Set(deliverables.map((value) => value.trim()).filter(Boolean))];
  if (cleaned.length > MAX_BOT_DELIVERABLES) {
    throw new Error(`Use at most ${MAX_BOT_DELIVERABLES} deliverable paths.`);
  }
  const config = { ...agent.config };
  if (cleaned.length) config.expectedDeliverables = cleaned;
  else delete config.expectedDeliverables;
  return patchBotConfig(agent, config, workspaceId);
}

/**
 * A linked file this panel could not resolve: the link survived, the file did
 * not, or this viewer may no longer read it. `removed` tells the two apart so a
 * broken link can be cleared instead of pretending the library is empty.
 */
export interface BotLibraryLink {
  fileId: string;
  status: "loading" | "ready" | "missing" | "error";
  name?: string;
  mime?: string;
  size?: number;
  scope?: "personal" | "workspace";
  updatedAt?: number;
  error?: string;
}

export const botFileDownloadPath = (fileId: string): string => `/api/files/${encodeURIComponent(fileId)}/download`;

/** The extensions the existing deliverable viewer renders, plus raster images. */
const PREVIEW_TEXT = ["md", "txt", "csv", "json"];
const PREVIEW_EMBED = ["html", "pdf"];
const PREVIEW_IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "avif"];

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** `null` means the existing viewer can render it; a string says why it cannot. */
export function previewLimitation(name: string, mime?: string): string | null {
  const extension = fileExtension(name);
  if (PREVIEW_TEXT.includes(extension) || PREVIEW_EMBED.includes(extension)) return null;
  if (PREVIEW_IMAGE.includes(extension) || (mime ?? "").startsWith("image/")) return null;
  if (extension === "mp4" || mime === "video/mp4") return null;
  return extension ? `No in-panel preview for .${extension} files.` : "No in-panel preview for files without an extension.";
}
