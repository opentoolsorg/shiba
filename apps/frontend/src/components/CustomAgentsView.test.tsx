// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("shows a skeleton, then an error with retry", async () => {
    const fetchMock = vi.fn(
      () => new Promise(() => {}) as Promise<Response>,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<CustomAgentsView />);
    expect(screen.getByLabelText("Loading agents")).toBeTruthy();

    const failed = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", failed);
    rerender(<CustomAgentsView />);
    // The first mount already started a hanging fetch. Render a fresh tree.
    cleanup();
    render(<CustomAgentsView />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("503");
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("requires slug, name, and instructions before creating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ agents: [] }) })),
    );
    render(<CustomAgentsView />);
    await waitFor(() => {
      expect(screen.getByText("No custom agents")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(screen.getByRole("alert").textContent).toContain("Slug, name, and instructions are required.");
  });

  it("asks before deleting and removes the row after the server accepts", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({
          agents: [
            {
              id: "ag-1",
              slug: "reviewer",
              version: 1,
              config: { name: "Reviewer", instructions: "Review PRs carefully.", harness: "opencode" },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomAgentsView />);
    await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => {
      expect(screen.getByText("Agent deleted.")).toBeTruthy();
    });
  });
});
