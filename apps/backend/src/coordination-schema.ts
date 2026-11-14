import { CollaborationStoreError } from "./collaboration-store.js";
import type { Env } from "./env.js";

const initialized = new WeakSet<D1Database>();

/** Apply 0059 when this process can read the migration file. Production uses the migrations dir. */
export async function ensureCoordinationSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT) throw new CollaborationStoreError("Collaboration storage is unavailable.", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  const ready = await env.AGENT_AUDIT.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_reply_claims'",
  ).first<{ name: string }>();
  if (!ready) {
    const node = typeof process !== "undefined" && Boolean(process.versions?.node);
    if (!node) throw new CollaborationStoreError("Coordination storage is not migrated.", 503);
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../migrations/0059_coordination.sql", import.meta.url), "utf8");
    for (const statement of sql.split(/;\s*\n/).map((part) => part.replace(/--[^\n]*/g, "").trim()).filter(Boolean)) {
      try {
        await env.AGENT_AUDIT.prepare(statement).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists|duplicate column/i.test(message)) throw error;
      }
    }
  }
  initialized.add(env.AGENT_AUDIT);
}
