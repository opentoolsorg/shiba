import { CollaborationStoreError } from "./collaboration-store.js";
import type { Env } from "./env.js";

/** Schema is installed by D1 migrations before the Worker starts. */
export async function ensureCoordinationSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT) throw new CollaborationStoreError("Collaboration storage is unavailable.", 503);
}
