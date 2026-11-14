import { describe, expect, it, vi } from "vitest";
import { publishWorkspaceEvent, workspaceRunEvent } from "../src/workspace-events-client.js";

describe("workspace live events publish", () => {
  it("no-ops when WorkspaceEvents binding is absent", async () => {
    const event = await publishWorkspaceEvent(
      {},
      workspaceRunEvent("ws_1", "run_1", "run.updated", { status: "running" }),
    );
    expect(event.kind).toBe("run.updated");
    expect(event.entityId).toBe("run_1");
  });

  it("forwards to the DO stub when bound", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const ns = { idFromName: (id: string) => id, get: () => ({ fetch }) };
    await publishWorkspaceEvent(
      { WorkspaceEvents: ns as never },
      workspaceRunEvent("ws_1", "run_1", "run.updated"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});