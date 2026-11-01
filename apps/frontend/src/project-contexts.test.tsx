// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectContexts } from "./project-contexts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const project = (id: string) => ({ id, name: id, purpose: "A project", defaultCustomAgentId: null, defaultHarness: null });

describe("authenticated project picker data", () => {
  it("waits for sign-in, then fetches and clears the list on sign-out", async () => {
    const request = vi.fn(async () => Response.json({ projects: [project("owner-a-project")] }));
    vi.stubGlobal("fetch", request);
    const view = renderHook(({ owner }) => useProjectContexts(owner), { initialProps: { owner: null as string | null } });
    expect(request).not.toHaveBeenCalled();
    view.rerender({ owner: "owner-a" });
    await waitFor(() => expect(view.result.current.map((item) => item.id)).toEqual(["owner-a-project"]));
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/memory/projects", { credentials: "same-origin", cache: "no-store" });
    view.rerender({ owner: null });
    expect(view.result.current).toEqual([]);
  });

  it("does not restore an old owner's delayed response after identity changes", async () => {
    let finishOld: ((response: Response) => void) | undefined;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ projects: [project("owner-b-project")] }));
    vi.stubGlobal("fetch", request);
    const view = renderHook(({ owner }) => useProjectContexts(owner), { initialProps: { owner: "owner-a" } });
    view.rerender({ owner: "owner-b" });
    await waitFor(() => expect(view.result.current.map((item) => item.id)).toEqual(["owner-b-project"]));
    await act(async () => { finishOld?.(Response.json({ projects: [project("owner-a-project")] })); });
    expect(view.result.current.map((item) => item.id)).toEqual(["owner-b-project"]);
  });

  it("refreshes on project changes and ignores a superseded request", async () => {
    let finishOld: ((response: Response) => void) | undefined;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ projects: [project("new-project")] }));
    vi.stubGlobal("fetch", request);
    const view = renderHook(() => useProjectContexts("owner-a"));
    act(() => window.dispatchEvent(new Event("shiba:projects-updated")));
    await waitFor(() => expect(view.result.current.map((item) => item.id)).toEqual(["new-project"]));
    await act(async () => { finishOld?.(Response.json({ projects: [project("old-project")] })); });
    expect(view.result.current.map((item) => item.id)).toEqual(["new-project"]);
  });
});
