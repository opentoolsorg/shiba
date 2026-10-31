// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadSavedSkills } from "../saved";
import { FounderSkillLibrary } from "./FounderSkillLibrary";

vi.mock("../saved", () => ({ reloadSavedSkills: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("FounderSkillLibrary", () => {
  it.each([false, true])("reloads skills after installation and keeps success if reload fails (%s)", async (reloadFails) => {
    vi.mocked(reloadSavedSkills).mockImplementation(async () => {
      if (reloadFails) throw new Error("reload failed");
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/founder-skills") && !init?.method) {
        return Response.json({
          skills: [{
            id: "founder-stripe-revenue-pulse",
            name: "Stripe revenue pulse",
            description: "Daily MRR",
            author: "Shiba",
            schedule: { label: "Daily", cron: "0 8 * * *", timezone: "UTC" },
            bridgeCatalogIds: ["stripe"],
            requiresSensitiveApproval: false,
          }],
        });
      }
      if (url.includes("/install")) return Response.json({ ok: true, skill: { id: "skill-abc" } }, { status: 201 });
      return Response.json({ error: "not_found" }, { status: 404 });
    }));
    render(<FounderSkillLibrary />);
    await waitFor(() => expect(screen.getByText("Stripe revenue pulse")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Install draft" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/skill-abc/));
    expect(reloadSavedSkills).toHaveBeenCalledOnce();
  });
});
