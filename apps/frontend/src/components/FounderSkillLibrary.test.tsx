// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderSkillLibrary } from "./FounderSkillLibrary";

afterEach(() => cleanup());

describe("FounderSkillLibrary", () => {
  it("lists library skills and installs a draft", async () => {
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
    await waitFor(() => expect(screen.getByText("Stripe revenue pulse")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Install draft" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/skill-abc/));
  });
});
