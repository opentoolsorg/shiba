// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpacesView } from "./SpacesView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SpacesView", () => {
  it("lists spaces from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/api/spaces/templates")) {
          return Response.json({ ok: true, templates: [{ id: "blank", label: "Blank", description: "Empty" }] });
        }
        if (url.endsWith("/api/spaces")) {
          return Response.json({ ok: true, spaces: [{ id: "space-aaaaaaaaaaaaaaaaaaaaaaaa", name: "Desk", template: "blank", updatedAt: 1 }] });
        }
        return Response.json({ ok: false }, { status: 404 });
      }),
    );

    render(<SpacesView />);
    expect(await screen.findByText("Desk")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Desk/ }));
    expect(window.location.pathname).toContain("space-aaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
