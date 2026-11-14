const keyFor = (workspaceId: string) => `shiba:palette:recents:${workspaceId}`;

/** Last opened palette ids. Values are ids only, never message text. */
export function readRecents(workspaceId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(workspaceId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, 8);
  } catch {
    return [];
  }
}

export function pushRecent(workspaceId: string, id: string): string[] {
  const next = [id, ...readRecents(workspaceId).filter((item) => item !== id)].slice(0, 8);
  try { localStorage.setItem(keyFor(workspaceId), JSON.stringify(next)); } catch { /* storage can be blocked */ }
  return next;
}
