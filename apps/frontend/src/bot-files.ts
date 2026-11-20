import type { KnowledgeFile, KnowledgeScope } from "@shiba/shared";
import type { BotLibraryLink } from "./bot-library";

/** One document this viewer may attach: it came back from the file route under its own access check. */
export interface AuthorizedBotFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  scope: KnowledgeScope;
  updatedAt: number;
}

const asFile = (value: unknown, scope: KnowledgeScope): AuthorizedBotFile | null => {
  const row = value as Partial<KnowledgeFile> | null | undefined;
  if (!row || typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    mime: typeof row.mime === "string" ? row.mime : "application/octet-stream",
    size: typeof row.size === "number" ? row.size : 0,
    scope: row.scope === "workspace" ? "workspace" : scope,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
};

/**
 * Files the current viewer may attach in one scope. This is the same list the
 * Files view renders, so the picker can never offer a document the file route
 * would then refuse.
 */
export async function listAuthorizedFiles(scope: KnowledgeScope): Promise<AuthorizedBotFile[]> {
  const response = await fetch(`/api/files?scope=${scope}`, { credentials: "same-origin", cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as { files?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Files unavailable (${response.status}).`);
  if (!Array.isArray(body.files)) throw new Error("Files unavailable.");
  return body.files
    .filter((item) => !(item as { archivedAt?: number | null } | null)?.archivedAt)
    .map((item) => asFile(item, scope))
    .filter((item): item is AuthorizedBotFile => item !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Both scopes, personal first, so a linked file can be matched to its own list entry. */
export async function listAttachableFiles(): Promise<{ files: AuthorizedBotFile[]; error: string | null }> {
  const results = await Promise.allSettled([listAuthorizedFiles("personal"), listAuthorizedFiles("workspace")]);
  const files: AuthorizedBotFile[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") files.push(...result.value);
    else failures.push(result.reason instanceof Error ? result.reason.message : "Files unavailable.");
  }
  return { files, error: failures.length === results.length ? failures[0] ?? "Files unavailable." : null };
}

/**
 * Resolves one stored link through the authorized file route. A link is only an
 * id: the response is the file's own access decision, so a removed document and
 * a document this viewer may not read both come back as `missing` rather than
 * leaking whether it exists.
 */
export async function readBotLibraryLink(fileId: string, signal?: AbortSignal): Promise<BotLibraryLink> {
  let response: Response;
  try {
    response = await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) return { fileId, status: "loading" };
    return { fileId, status: "error", error: error instanceof Error ? error.message : "Could not reach the file." };
  }
  if (response.status === 404) return { fileId, status: "missing", error: "Removed, or not available to you." };
  const body = (await response.json().catch(() => ({}))) as { file?: unknown; error?: string };
  if (!response.ok) return { fileId, status: "error", error: body.error ?? `File unavailable (${response.status}).` };
  const file = asFile(body.file, "personal");
  if (!file) return { fileId, status: "error", error: "The file route returned no usable file." };
  return { fileId, status: "ready", name: file.name, mime: file.mime, size: file.size, scope: file.scope, updatedAt: file.updatedAt };
}
