// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillLibraryCards } from "./SkillLibraryCards";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SkillLibraryCards", () => {
  it("calls install and refreshes the library", async () => {
    let installed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/install")) {
          installed = true;
          return Response.json({ ok: true, skillId: "skill-aaaaaaaaaaaaaaaaaaaaaaaa" }, { status: 201 });
        }
        if (url.includes("/api/skills/library")) {
          return Response.json({
            ok: true,
            skills: [{
              slug: "pr-review-checklist",
              name: "PR review checklist",
              summary: "Structured review pass",
              tags: ["review"],
              version: "1.0.0",
              installed,
              updateAvailable: false,
            }],
          });
        }
        if (url.includes("/api/skills?")) {
          return Response.json({ skills: [] });
        }
        return Response.json({ ok: false }, { status: 404 });
      }),
    );

    render(<SkillLibraryCards />);
    expect(await screen.findByText("PR review checklist")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(screen.getByText("Installed")).toBeDefined();
    });
  });
});
