/** Normalize user-facing shorthand without weakening server-side repository validation. */
export function normalizeRepositoryInput(value: string): string | null {
  const input = value.trim();
  if (!input || input.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : /^github\.com\//i.test(input) ? `https://${input}` : `https://github.com/${input}`);
  } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1);
  if (parts.length !== 2) return null;
  const [owner, rawRepo] = parts;
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (![owner, repo].every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part))) return null;
  return `https://github.com/${owner}/${repo}`;
}

export const REPOSITORY_INPUT_ERROR = "Enter owner/repo or a full https://github.com/owner/repo URL.";
