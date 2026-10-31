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
});
