import { describe, expect, it } from "vitest";
import { workspaceEventsName } from "../src/platform/workspace-events-do.js";

describe("workspace events", () => {
  it("normalizes workspace ids for DO stubs", () => {
    expect(workspaceEventsName("WS_ABC")).toBe("ws_abc");
  });
});