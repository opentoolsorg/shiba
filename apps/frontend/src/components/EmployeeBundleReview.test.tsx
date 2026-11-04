// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { validateEmployeeBundle } from "@shiba/shared";
import { EmployeeBundleExport, EmployeeBundleReview } from "./EmployeeBundleReview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const recipe = () => validateEmployeeBundle({
  format: "shiba.employee-bundle.v1", audience: "personal",
  profile: { name: "Finance reviewer", roleTemplateId: "finance", harness: "codex", instructions: "Prepare reviewed drafts only.", expectedDeliverables: ["finance/summary.md"] },
  skills: [{ name: "Evidence checks", instructions: "Use only cited approved facts.", provenance: { kind: "managed-skill", id: "skill-original", revision: "3" } }],
  requirements: [{ kind: "app", name: "Stripe", description: "Optional reporting source.", configurationRequired: ["Connect your own account"] }],
  routines: [{ name: "Monthly summary", description: "Draft a summary.", enabled: false, configurationRequired: ["Choose schedule"] }],
});
const result = { employeeId: "cag-new", skillIds: ["skill-new"], profileState: "archived_pending_review", skillState: "draft", requirementsState: "unconfigured", routinesState: "descriptions_only" };

describe("reviewed employee bundles", () => {
  it("shows exact instructions and requirements and requires human review before importing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json(url.endsWith("preview") ? { recipe: body.recipe, previewId: "ebp-preview", digest: "f".repeat(64), expiresAt: Date.now() + 60_000 } : result);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    render(<EmployeeBundleReview recipe={recipe()} workspaceId="team-selected" onClose={vi.fn()} onImported={onImported}/>);
    expect(screen.getByText("Prepare reviewed drafts only.")).toBeTruthy();
    expect(screen.getByText(/workspace-visible archived bot and personal draft skills/)).toBeTruthy();
    expect(screen.getByText(/executable schedules are not installed/)).toBeTruthy();
    const action = screen.getByRole("button", { name: "Import archived bot and draft skills" }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    await screen.findByText(/Review digest:/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(action.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(action);
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(result));
    const write = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(write).toMatchObject({ expectedDigest: "f".repeat(64), reviewed: true, recipe: recipe() });
    expect(write.importId).toBeTypeOf("string");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/employee-bundles/preview", "/api/employee-bundles/import"]);
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Shiba-Workspace"))).toEqual(["team-selected", "team-selected"]);
  });

  it("freezes only explicitly included skills and clears review when selection changes", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ recipe: JSON.parse(String(init?.body)).recipe,
      previewId: "ebp-preview", digest: "a".repeat(64), expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EmployeeBundleReview recipe={recipe()} onClose={vi.fn()} onImported={vi.fn()}/>);
    await screen.findByText(/Review digest:/);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Evidence checks/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).recipe.skills).toEqual([]);
    expect((screen.getByRole("checkbox", { name: /I reviewed/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Import archived bot and draft skills" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the same idempotency key when retrying a failed import", async () => {
    let imports = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("preview")) return Response.json({ recipe: JSON.parse(String(init?.body)).recipe, previewId: "ebp-preview", digest: "a".repeat(64), expiresAt: Date.now() + 60_000 });
      imports += 1;
      return imports === 1 ? Response.json({ error: "Retry the same import." }, { status: 503 }) : Response.json(result);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    render(<EmployeeBundleReview recipe={recipe()} onClose={vi.fn()} onImported={onImported}/>);
    await screen.findByText(/Review digest:/);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import archived bot and draft skills" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Import archived bot and draft skills" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    const writes = fetchMock.mock.calls.filter(([url]) => url.endsWith("import")).map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes[0]).toEqual(writes[1]);
  });

  it("ignores a late preview from the previously selected workspace", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get("X-Shiba-Workspace") === "team-old")
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      return Response.json({ recipe: JSON.parse(String(init?.body)).recipe, previewId: "ebp-new", digest: "b".repeat(64), expiresAt: Date.now() + 60_000 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const value = recipe();
    const view = render(<EmployeeBundleReview recipe={value} workspaceId="team-old" onClose={vi.fn()} onImported={vi.fn()}/>);
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    view.rerender(<EmployeeBundleReview recipe={value} workspaceId="team-new" onClose={vi.fn()} onImported={vi.fn()}/>);
    await screen.findByText(`Review digest: ${"b".repeat(64)}`);
    resolveOld?.(Response.json({ recipe: value, previewId: "ebp-old", digest: "a".repeat(64), expiresAt: Date.now() + 60_000 }));
    await waitFor(() => expect(screen.queryByText(`Review digest: ${"a".repeat(64)}`)).toBeNull());
    expect(screen.getByText(`Review digest: ${"b".repeat(64)}`)).toBeTruthy();
  });

  it("exports only chosen current active skill versions and reports missing profile ownership", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.startsWith("/api/skills") ? Response.json({ skills: [
      { id: "skill-active", version: 3, activeVersion: 3, status: "active", name: "Active" },
      { id: "skill-draft", version: 1, status: "draft", name: "Private draft" },
      { id: "skill-stale", version: 4, activeVersion: 3, status: "active", name: "Changed source" },
    ] }) : Response.json({ error: "profile_owner_required" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EmployeeBundleExport employeeId="cag-existing" expectedVersion={7} onClose={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Active/ }));
    expect(screen.queryByText("Private draft")).toBeNull();
    expect(screen.queryByText("Changed source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prepare bundle JSON" }));
    await screen.findByText("profile_owner_required");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ employeeId: "cag-existing", expectedVersion: 7, skillPins: [{ skillId: "skill-active", version: 3 }] });
    expect(screen.queryByLabelText("Exported employee bundle JSON")).toBeNull();
  });
});
