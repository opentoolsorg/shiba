/** Worker-side fetch of repo AGENTS.md (never inside the sandbox). */
export async function fetchAgentsMd(
  owner: string,
  repo: string,
  token: string,
  apiBase?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const base = (apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const path = `/repos/${owner}/${repo}/contents/AGENTS.md`;
  const response = await fetchImpl(`${base}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "shiba",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = await response.json() as { content?: string; encoding?: string };
  if (body.encoding !== "base64" || typeof body.content !== "string") return null;
  try {
    const text = atob(body.content.replace(/\n/g, ""));
    const trimmed = text.trim();
    return trimmed === "" ? null : trimmed.slice(0, 12_000);
  } catch {
    return null;
  }
}
