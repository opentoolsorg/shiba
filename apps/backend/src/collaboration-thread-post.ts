/**
 * Seam for room thread posts. The rooms workstream owns the real writer.
 * This stub matches that signature and does not write.
 */
import type { PostRoomEventInput } from "@shiba/shared";
import type { CollaborationScope } from "./collaboration-store.js";
import type { Env } from "./env.js";

export async function postRoomEvent(
  _env: Env,
  _scope: CollaborationScope,
  _input: PostRoomEventInput & { actorId?: string; userId?: string; now?: number },
): Promise<{ posted: false }> {
  return { posted: false };
}
