import { describe, expect, it, vi } from "vitest";
import { appendRunMilestone } from "../src/run-milestones.js";
import { publishWorkspaceEvent } from "../src/platform/workspace-events-do.js";

vi.mock("../src/collaboration-thread-post.js", () => ({ postRoomEvent: vi.fn(async () => undefined) }));

describe("workspace live events publish", () => {
  it("no-ops when WorkspaceEvents binding is absent", async () => {
    await expect(
      publishWorkspaceEvent({} as never, "ws_1", { kind: "run.updated", entityId: "run_1" }),
    ).resolves.toBeUndefined();
  });

  it("forwards to the Durable Object stub when bound", async () => {
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 200 }));
    const env = {
      WorkspaceEvents: {
        getByName: () => ({ fetch }),
      },
    };
    await publishWorkspaceEvent(env as never, "WS_1", { kind: "run.updated", entityId: "run_1", audience: { userIds: ["owner@example.test"] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL((request as Request).url).pathname).toBe("/internal/publish");
    if (!request) throw new Error("Expected a publish request.");
    expect(await request.json()).toMatchObject({
      id: expect.stringMatching(/^wse_/), workspaceId: "ws_1", kind: "run.updated",
      entityId: "run_1", audience: { userIds: ["owner@example.test"] }, at: expect.any(Number),
    });
  });
});

describe("run milestone audiences", () => {
  function fixture() {
    const frames: Record<string, unknown>[] = [];
    const env = {
      AGENT_AUDIT: {
        prepare: () => ({ bind: () => ({ first: async () => ({ seq: 0 }), run: async () => ({}) }) }),
      },
      WorkspaceEvents: { getByName: () => ({ fetch: async (request: Request) => {
        frames.push(await request.json() as Record<string, unknown>);
        return Response.json({ ok: true });
      } }) },
    };
    return { env, frames };
  }

  it("publishes private milestones only to their owner", async () => {
    const { env, frames } = fixture();
    await appendRunMilestone(env as never, {
      workspaceId: "ws_1", runId: "run_1", kind: "milestone", text: "Ready", userId: "owner@example.test",
    });
    expect(frames).toEqual([expect.objectContaining({ audience: { userIds: ["owner@example.test"] } })]);
  });

  it("keeps room milestones scoped to current room membership", async () => {
    const { env, frames } = fixture();
    const roomId = `room_${"ab".repeat(12)}`;
    await appendRunMilestone(env as never, {
      workspaceId: "ws_1", runId: "run_1", kind: "milestone", text: "Ready", roomId,
      userId: "owner@example.test",
    });
    expect(frames).toEqual([expect.objectContaining({ audience: { roomId } })]);
  });

  it("stores milestones without broadcasting when their audience is unknown", async () => {
    const { env, frames } = fixture();
    await appendRunMilestone(env as never, {
      workspaceId: "ws_1", runId: "run_1", kind: "milestone", text: "Ready",
    });
    expect(frames).toEqual([]);
  });
});
