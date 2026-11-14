/**
 * Contract between WS01 (WorkspaceEvents DO) and dashboard subscribers.
 * WS08 publishes and subscribes; the DO implementation ships in WS01.
 */
import { z } from "zod";

export const workspaceEventKinds = [
  "task.updated",
  "task.created",
  "run.updated",
  "approval.updated",
  "search.indexed",
  "ask_user.pending",
  "ask_user.answered",
] as const;

export type WorkspaceEventKind = (typeof workspaceEventKinds)[number];

export const workspaceEventSchema = z.object({
  id: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  kind: z.enum(workspaceEventKinds),
  entityId: z.string().min(1).max(200),
  at: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

export const WORKSPACE_EVENTS_WS_PATH = "/api/workspaces";
export const workspaceEventsStreamPath = (workspaceId: string) =>
  `${WORKSPACE_EVENTS_WS_PATH}/${encodeURIComponent(workspaceId)}/events/stream`;