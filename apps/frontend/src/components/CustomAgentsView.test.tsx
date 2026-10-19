// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

afterEach(() => cleanup());

import { CustomAgentsView } from "./CustomAgentsView";

describe("CustomAgentsView", () => {
  it("lists agents from the API and opens the create form", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/custom-agents") {
        return {
          ok: true,
          json: async () => ({
            agents: [
              {
                id: "ag-1",
                slug: "reviewer",
                version: 1,
                config: {
                  name: "Reviewer",
                  instructions: "Review PRs carefully.",
                  harness: "opencode",
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CustomAgentsView />);

    await waitFor(() => {
      expect(screen.getByText("Reviewer")).toBeTruthy();
    });
    expect(screen.getByText(/reviewer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create agent" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByDisplayValue("Reviewer")).toBeTruthy();
  });
});
