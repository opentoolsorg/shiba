// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroupsSettings } from "./Groups";

describe("GroupsSettings", () => {
  it("renders groups from the governance API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          groups: [
            {
              groupId: "wgrp_aa",
              workspaceId: "ws_" + "a".repeat(24),
              name: "Design",
              version: 1,
              createdAt: 1,
            },
          ],
        }),
      ),
    );
    render(<GroupsSettings workspaceId={`ws_${"a".repeat(24)}`} />);
    await waitFor(() => {
      expect(screen.getByText("Design")).toBeTruthy();
    });
  });
});
