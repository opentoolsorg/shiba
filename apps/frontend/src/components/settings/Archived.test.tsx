// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArchivedSettings } from "./Archived";

describe("ArchivedSettings", () => {
  it("lists archived resources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              resourceKind: "task",
              resourceId: "t1",
              title: "Old task",
              archivedAt: 1,
              restoreSupported: true,
            },
          ],
        }),
      ),
    );
    render(<ArchivedSettings workspaceId={`ws_${"a".repeat(24)}`} />);
    await waitFor(() => {
      expect(screen.getByText("Old task")).toBeTruthy();
    });
  });
});
