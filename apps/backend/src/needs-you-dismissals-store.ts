import { DISMISS_TTL_MS, type NeedsYouDismissalStore } from "./needs-you-suggestions.js";

/** Registered by the route composition; the suggestion policy has no storage dependency. */
export function createNeedsYouDismissalStore(db: D1Database): NeedsYouDismissalStore {
  return {
    readDismissedIds: (ownerId, now) => readDismissedIds(db, ownerId, now),
    dismissSuggestion: (ownerId, suggestionId, now) => dismissSuggestion(db, ownerId, suggestionId, now),
  };
}

export async function readDismissedIds(db: D1Database | undefined, ownerId: string, now: number): Promise<Set<string>> {
  if (!db) return new Set();
  try {
    const rows = await db.prepare("SELECT suggestion_id FROM needs_you_dismissals WHERE owner_id = ? AND dismissed_at > ?")
      .bind(ownerId, now - DISMISS_TTL_MS).all<{ suggestion_id: string }>();
    return new Set(rows.results.map((row) => row.suggestion_id));
  } catch {
    // Table missing before the migration is applied: show everything.
    return new Set();
  }
}

export async function dismissSuggestion(db: D1Database, ownerId: string, suggestionId: string, now: number): Promise<void> {
  await db.prepare(
    "INSERT INTO needs_you_dismissals (owner_id, suggestion_id, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(owner_id, suggestion_id) DO UPDATE SET dismissed_at = excluded.dismissed_at",
  ).bind(ownerId, suggestionId, now).run();
}
