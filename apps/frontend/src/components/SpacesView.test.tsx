// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpacesView } from "./SpacesView";

beforeEach(() => {
  window.history.replaceState(null, "", "/spaces/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const firstId = "space-aaaaaaaaaaaaaaaaaaaaaaaa";
const secondId = "space-bbbbbbbbbbbbbbbbbbbbbbbb";
const spaceDetail = (id: string, name: string) => ({ id, name, template: "blank", updatedAt: 1, items: [] });

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockSpacesFetch(details: Record<string, Promise<Response>>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => {
    const url = String(input);
    if (url === "/api/spaces") return Promise.resolve(Response.json({ spaces: [] }));
    if (url === "/api/spaces/templates") return Promise.resolve(Response.json({ templates: [] }));
    return details[url] ?? Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
  }));
}

function navigateTo(path: string) {
  act(() => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

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

  it("hides the previous detail while another space loads", async () => {
    const second = deferredResponse();
    mockSpacesFetch({
      [`/api/spaces/${firstId}`]: Promise.resolve(Response.json({ space: spaceDetail(firstId, "First desk") })),
      [`/api/spaces/${secondId}`]: second.promise,
    });
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    expect(await screen.findByRole("heading", { name: "First desk" })).toBeDefined();

    navigateTo(`/spaces/${secondId}/`);
    expect(screen.queryByRole("heading", { name: "First desk" })).toBeNull();
    await act(async () => second.resolve(Response.json({ space: spaceDetail(secondId, "Second desk") })));
    expect(await screen.findByRole("heading", { name: "Second desk" })).toBeDefined();
  });

  it("ignores a late response from the previous space", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    mockSpacesFetch({ [`/api/spaces/${firstId}`]: first.promise, [`/api/spaces/${secondId}`]: second.promise });
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    navigateTo(`/spaces/${secondId}/`);

    await act(async () => second.resolve(Response.json({ space: spaceDetail(secondId, "Second desk") })));
    expect(await screen.findByRole("heading", { name: "Second desk" })).toBeDefined();
    await act(async () => first.resolve(Response.json({ space: spaceDetail(firstId, "First desk") })));
    expect(screen.getByRole("heading", { name: "Second desk" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "First desk" })).toBeNull();
  });

  it("ignores stale request errors after navigating back to the list", async () => {
    const first = deferredResponse();
    mockSpacesFetch({ [`/api/spaces/${firstId}`]: first.promise });
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    navigateTo("/spaces/");

    await act(async () => first.reject(new Error("Stale detail failure")));
    expect(screen.queryByText("Stale detail failure")).toBeNull();
    expect(screen.getByRole("heading", { name: "Spaces" })).toBeDefined();
  });

  it("renders breadcrumbs in the header", async () => {
    mockSpacesFetch({});
    render(<SpacesView scope="workspace" />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.textContent).toContain("Workspace");
    expect(nav.textContent).toContain("Extensions");
    expect(nav.textContent).toContain("Apps");
    expect(screen.getByRole("button", { name: /New Space/i })).toBeDefined();
  });

  it("adds and removes items, then refreshes the detail", async () => {
    let items: Array<{ kind: string; ref: string; addedAt: number }> = [];
    const calls: Array<[string, string, string | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/spaces") return Response.json({ spaces: [] });
      if (url === "/api/spaces/templates") return Response.json({ templates: [] });
      if (url === `/api/spaces/${firstId}/items`) {
        calls.push([url, init?.method ?? "GET", init?.body as string | undefined]);
        const body = JSON.parse(String(init?.body)) as { kind: string; ref: string };
        items = init?.method === "DELETE" ? [] : [{ ...body, addedAt: 1 }];
        return Response.json({ ok: true });
      }
      return Response.json({ space: { ...spaceDetail(firstId, "Desk"), items } });
    }));
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    await screen.findByRole("heading", { name: "Desk" });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "repo" } });
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "acme/web" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("repo · acme/web");
    expect(calls[0]).toEqual([`/api/spaces/${firstId}/items`, "POST", JSON.stringify({ kind: "repo", ref: "acme/web" })]);
    fireEvent.click(screen.getByRole("button", { name: "Remove repo acme/web" }));
    await screen.findByText("No items yet.");
    expect(calls[1]![1]).toBe("DELETE");
  });

  it("shows API errors when adding fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/spaces") return Response.json({ spaces: [] });
      if (url === "/api/spaces/templates") return Response.json({ templates: [] });
      if (url.endsWith("/items")) return Response.json({ error: "invalid_item" }, { status: 400 });
      return Response.json({ space: spaceDetail(firstId, "Desk") });
    }));
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    await screen.findByRole("heading", { name: "Desk" });
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("invalid_item");
  });

  it("says the change was saved when only the refresh fails", async () => {
    let posted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/spaces") return Response.json({ spaces: [] });
      if (url === "/api/spaces/templates") return Response.json({ templates: [] });
      if (url.endsWith("/items")) { posted = true; return Response.json({ ok: true }); }
      return posted ? Response.json({ error: "down" }, { status: 500 }) : Response.json({ space: spaceDetail(firstId, "Desk") });
    }));
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    await screen.findByRole("heading", { name: "Desk" });
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Saved, but the list could not refresh/);
  });

  it("does not refetch or clear another space when an item change finishes after switching", async () => {
    const post = deferredResponse();
    const detailFetches: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/spaces") return Promise.resolve(Response.json({ spaces: [] }));
      if (url === "/api/spaces/templates") return Promise.resolve(Response.json({ templates: [] }));
      if (url === `/api/spaces/${firstId}/items`) return post.promise;
      detailFetches.push(url);
      const id = url.endsWith(`${secondId}`) ? secondId : firstId;
      return Promise.resolve(Response.json({ space: spaceDetail(id, id === secondId ? "Second" : "First") }));
    }));
    window.history.replaceState(null, "", `/spaces/${firstId}/`);
    render(<SpacesView />);
    await screen.findByRole("heading", { name: "First" });
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    navigateTo(`/spaces/${secondId}/`);
    await screen.findByRole("heading", { name: "Second" });
    expect((screen.getByLabelText("Reference") as HTMLInputElement).value).toBe("");
    const before = detailFetches.length;
    await act(async () => post.resolve(Response.json({ ok: true })));
    expect(detailFetches.length).toBe(before);
    expect(screen.getByRole("heading", { name: "Second" })).toBeDefined();
  });
});
