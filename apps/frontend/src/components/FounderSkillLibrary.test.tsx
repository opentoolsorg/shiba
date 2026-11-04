// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadSavedSkills } from "../saved";
import { FounderSkillLibrary } from "./FounderSkillLibrary";

vi.mock("../saved", () => ({ reloadSavedSkills: vi.fn(), useSavedSkills: () => ({ skills: [] }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("FounderSkillLibrary", () => {
  const entry = { id: "founder-stripe-revenue-pulse", name: "Stripe revenue pulse", description: "Daily metrics", author: "Shiba", schedule: { label: "Daily", cron: "0 8 * * *", timezone: "UTC" }, integrationCatalogIds: ["stripe"], requiresSensitiveApproval: false };
  const recipe = { format: "shiba.employee-bundle.v1", audience: "personal", profile: { name: "Revenue writer", harness: "opencode", instructions: "Draft from supplied figures. No account writes.", expectedDeliverables: ["reports/revenue.md"] }, skills: [{ name: "Revenue style", instructions: "State assumptions." }], requirements: [{ kind: "app", name: "stripe", description: "Configure separately.", configurationRequired: ["Choose exact grants"] }], routines: [{ name: "Daily pulse", description: "Suggested only", configurationRequired: ["Choose a schedule"], enabled: false }] };

  it("continues setup through the actual reviewed-bundle UI without importing before explicit review", async () => {
    const imports: unknown[] = [];
    vi.mocked(reloadSavedSkills).mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/founder-skills") return Response.json({ skills: [entry] });
      if (url.endsWith("/setup")) return Response.json({ recipe });
      if (url.endsWith("/preview")) return Response.json({ previewId: "ebp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", digest: "b".repeat(64), expiresAt: Date.now() + 60_000, recipe });
      if (url.endsWith("/import")) { imports.push(JSON.parse(String(init?.body))); return Response.json({ employeeId: "employee-draft", skillIds: ["skill-draft"], profileState: "archived_pending_review", skillState: "draft", requirementsState: "unconfigured", routinesState: "descriptions_only" }, { status: 201 }); }
      return Response.json({ error: "not_found" }, { status: 404 });
    }));
    render(<FounderSkillLibrary />);
    fireEvent.click(await screen.findByRole("button", { name: "Review employee setup: Stripe revenue pulse" }));
    await screen.findByText(`Review digest: ${"b".repeat(64)}`);
    const submit = screen.getByRole("button", { name: "Import archived bot and draft skills" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(imports).toEqual([]);
    expect(screen.getByText(/executable schedules are not installed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed these instructions/ }));
    fireEvent.click(submit);
    await screen.findByText(/Archived bot employee-draft and 1 draft skill/);
    expect(imports).toEqual([expect.objectContaining({ expectedDigest: "b".repeat(64), reviewed: true, recipe })]);
    expect(reloadSavedSkills).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/deploy|\/activate|\/connections|\/automations/.test(String(url)))).toBe(false);
  });

  it("does not fall back to private setup or create employees after a denied setup read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => String(input) === "/api/founder-skills" ? Response.json({ skills: [entry] }) : Response.json({ error: "source_access_changed" }, { status: 403 })));
    render(<FounderSkillLibrary />);
    fireEvent.click(await screen.findByRole("button", { name: /Review employee setup:/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("source_access_changed");
    expect(screen.queryByRole("region", { name: "Review employee bundle" })).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("deduplicates rapid install clicks and ignores a late result after scope unmount", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => String(input) === "/api/founder-skills" ? Response.json({ skills: [entry] }) : pending));
    const { unmount } = render(<FounderSkillLibrary />);
    const install = await screen.findByRole("button", { name: "Install draft" });
    fireEvent.click(install); fireEvent.click(install);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => finish(Response.json({ skill: { id: "old-owner-draft", status: "draft", version: 1 } }, { status: 201 })));
    expect(reloadSavedSkills).not.toHaveBeenCalled();
  });

  it("labels an active installation as instructions and keeps the schedule unconfigured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ skills: [{ ...entry, installed: true, installedStatus: "active", installedVersion: 2 }] })));
    render(<FounderSkillLibrary />);
    expect(await screen.findByText("Installed instructions: active · v2")).toBeTruthy();
    expect(screen.getByText("Suggested: Daily · not scheduled")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Instructions installed" }) as HTMLButtonElement).disabled).toBe(true);
  });

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
            integrationCatalogIds: ["stripe"],
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
