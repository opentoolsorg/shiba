// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillLibraryCards } from "./SkillLibraryCards";
import { removeSkill, setSavedLibraryActor } from "../saved";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SkillLibraryCards", () => {
  it("shows current activation and disable state from the owned skill list instead of stale catalog metadata", async () => {
    setSavedLibraryActor("catalog-readiness-owner");
    const id = "skill-bbbbbbbbbbbbbbbbbbbbbbbb";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/disable")) return Response.json({ ok: true });
      if (url === "/api/skills/library") return Response.json({ ok: true, skills: [{ slug: "pr-review-checklist", name: "PR review checklist", summary: "Review", tags: [], version: "1.0.0", installed: true, installedSkillId: id, installedStatus: "draft", updateAvailable: false }] });
      return Response.json({ skills: [{ id, name: "PR review checklist", instructions: "Review safely", version: 1, activeVersion: 1, status: "active", owned: true }] });
    }));
    render(<SkillLibraryCards />);
    expect(await screen.findByText("Active instructions")).toBeTruthy();
    expect(screen.queryByText("Installed · draft")).toBeNull();
    await act(async () => removeSkill(id));
    expect(screen.queryByText("Active instructions")).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });

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
