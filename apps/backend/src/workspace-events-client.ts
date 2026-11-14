import { randomHex } from "./mailbox-store.js";
import type { WorkspaceEvent, WorkspaceEventKind } from "@shiba/shared";
import type { Env } from "./env.js";

type PublishEnv = Pick<Env, "WorkspaceEvents">;

/**
 * Fan-out contract for WS01's WorkspaceEvents DO. No-ops when the binding
 * is absent (pre-WS01 deploys); callers must not treat publish as delivery.
 */
export async function publishWorkspaceEvent(
  env: PublishEnv,
  input: Omit<WorkspaceEvent, "id" | "at"> & { at?: number },
): Promise<WorkspaceEvent> {
  const event: WorkspaceEvent = {
    ...input,
    id: `wse_${randomHex(16)}`,
    at: input.at ?? Date.now(),
  };
  const ns = env.WorkspaceEvents;
  if (!ns) return event;
  const stub = ns.get(ns.idFromName(event.workspaceId));
  await stub.fetch("https://workspace-events.internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  return event;
}

export function workspaceRunEvent(
  workspaceId: string,
  runId: string,
  kind: Extract<WorkspaceEventKind, "run.updated">,
  payload?: Record<string, unknown>,
): Omit<WorkspaceEvent, "id" | "at"> {
  return { workspaceId, kind, entityId: runId, payload };
}

export function workspaceTaskEvent(
  workspaceId: string,
  taskId: string,
  kind: Extract<WorkspaceEventKind, "task.created" | "task.updated">,
  payload?: Record<string, unknown>,
): Omit<WorkspaceEvent, "id" | "at"> {
  return { workspaceId, kind, entityId: taskId, payload };
}