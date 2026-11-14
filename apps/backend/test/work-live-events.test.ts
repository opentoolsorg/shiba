import { describe, expect, it, vi } from "vitest";
import { publishWorkspaceEvent } from "../src/platform/workspace-events-do.js";

describe("workspace live events publish", () => {
  it("no-ops when WorkspaceEvents binding is absent", async () => {
    await expect(
      publishWorkspaceEvent({} as never, "ws_1", { type: "run.updated", resourceId: "run_1", version: 1 }),
    ).resolves.toBeUndefined();
  });

  it("forwards to the Durable Object stub when bound", async () => {
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 200 }));
    const env = {
      WorkspaceEvents: {
        getByName: () => ({ fetch }),
      },
    };
    await publishWorkspaceEvent(env as never, "ws_1", { type: "run.updated", resourceId: "run_1", version: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL((request as Request).url).pathname).toBe("/internal/publish");
  });
});