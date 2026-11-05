// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TeamOnboardingDraft } from "./TeamOnboardingDraft";
import { EMPTY_ONBOARDING_DRAFT } from "../onboarding-draft";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workspaceId = `ws_${"a".repeat(24)}`;
const snapshot = (goal = "", revision = 0) => ({ schemaVersion: 2, revision, draftTask: { ...EMPTY_ONBOARDING_DRAFT, goal } });

describe("team first task draft", () => {
  it.each(["save", "reload", "configure"])("ignores late A %s completions after an unkeyed workspace change", async (operation) => {
    let finishA!: (value: Response) => void, finishB!: (value: Response) => void;
    const lateA = new Promise<Response>((done) => { finishA = done; });
    const loadingB = new Promise<Response>((done) => { finishB = done; });
    let aReads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/custom-agents") return Response.json({ agents: [] });
      const workspace = new Headers(init?.headers).get("X-Shiba-Workspace");
      if (workspace !== workspaceId) return loadingB;
      if (init?.method === "POST" || ++aReads > 1) return lateA;
      return Response.json(snapshot("Team A saved draft"));
    }); vi.stubGlobal("fetch", fetcher);
    const configure = vi.fn(), props = { onClose: vi.fn(), onOpenRooms: vi.fn(), onConfigureEmployee: configure };
    const view = render(<TeamOnboardingDraft workspaceId={workspaceId} {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Team A saved draft"));
    fireEvent.click(screen.getByRole("button", { name: operation === "reload" ? "Reload saved answers" : operation === "configure" ? "Configure team employee" : "Save team draft" }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(2));
    view.rerender(<TeamOnboardingDraft workspaceId={`ws_${"b".repeat(24)}`} {...props} />);
    expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Save team draft" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishA(Response.json(snapshot("Late A secret draft", 1))); });
    expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Save team draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(configure).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { finishB(Response.json(snapshot("Team B saved draft"))); });
    await waitFor(() => expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Team B saved draft"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves optional role and current employee choices without touching private sources, providers or run APIs", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/custom-agents") return Response.json({ agents: [{ id: "team-employee", version: 3, config: { name: "Team researcher" } }] });
      return Response.json(snapshot("", init?.method === "POST" ? 1 : 0));
    }); vi.stubGlobal("fetch", fetcher);
    const openRooms = vi.fn(), configureEmployee = vi.fn();
    render(<TeamOnboardingDraft workspaceId={workspaceId} workspaceName="Design team" onClose={vi.fn()} onOpenRooms={openRooms} onConfigureEmployee={configureEmployee} />);
    await screen.findByRole("option", { name: "Team researcher · v3" });
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Write a launch brief" } });
    fireEvent.change(screen.getByLabelText("Starting role, optional"), { target: { value: "marketing" } });
    fireEvent.change(screen.getByLabelText("Saved team employee, optional"), { target: { value: "team-employee" } });
    fireEvent.click(screen.getByRole("button", { name: "Save team draft" }));
    await screen.findByText(/Draft saved for your account/);
    const post = fetcher.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "save-draft", expectedRevision: 0, draftTask: { employeeId: "team-employee", employeeVersion: 3, employeeTemplateId: "marketing", sourceIds: [], completedSteps: [] } });
    expect(fetcher.mock.calls.every((call) => ["/api/custom-agents", "/api/onboarding/progress"].includes(String(call[0])))).toBe(true);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceId);
    fireEvent.click(screen.getByRole("button", { name: "Configure team employee" }));
    await waitFor(() => expect(configureEmployee).toHaveBeenCalledWith("marketing"));
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open team rooms" })); expect(openRooms).toHaveBeenCalledOnce();
  });

  it("preserves unsaved answers on CAS conflict and clears them when membership is revoked", async () => {
    let revoked = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/custom-agents") return Response.json({ agents: [] });
      if (revoked) return Response.json({ error: "Workspace access removed" }, { status: 404 });
      return Response.json(snapshot("Saved goal", init?.method === "POST" ? 1 : 0), { status: init?.method === "POST" ? 409 : 200 });
    }));
    render(<TeamOnboardingDraft workspaceId={workspaceId} onClose={vi.fn()} onOpenRooms={vi.fn()} />);
    await waitFor(() => expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Saved goal"));
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Unsaved edits" } });
    fireEvent.click(screen.getByRole("button", { name: "Save team draft" }));
    expect((await screen.findByRole("alert")).textContent).toContain("another tab");
    expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Unsaved edits");
    revoked = true; fireEvent.click(screen.getByRole("button", { name: "Reload saved answers" }));
    await waitFor(() => expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe(""));
  });

  it("aborts the old account/workspace request and ignores its late private draft", async () => {
    let resolve!: (response: Response) => void;
    const old = new Promise<Response>((done) => { resolve = done; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/custom-agents"
      ? Response.json({ agents: [] })
      : new Headers(init?.headers).get("X-Shiba-Workspace") === workspaceId ? old : Response.json(snapshot("Team B draft")));
    vi.stubGlobal("fetch", fetcher);
    const props = { onClose: vi.fn(), onOpenRooms: vi.fn() };
    const view = render(<TeamOnboardingDraft key="A" workspaceId={workspaceId} {...props} />);
    view.rerender(<TeamOnboardingDraft key="B" workspaceId={`ws_${"b".repeat(24)}`} {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Team B draft"));
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => { resolve(Response.json(snapshot("Late A draft"))); });
    expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Team B draft");
  });
});
