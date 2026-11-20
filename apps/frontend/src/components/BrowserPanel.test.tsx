// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "./BrowserPanel";

const live = {
  state: "live", url: "https://portal.example.test/sign-in",
  image: "ZGVtby1mcmFtZQ==", width: 1000, height: 700,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BrowserPanel", () => {
  it("watches read-only until takeover, then sends scaled viewport input and supports handback and stop", async () => {
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json(live);
      const action = JSON.parse(String(init.body));
      sent.push(action);
      if (action.action === "stop") return Response.json({ state: "closed" });
      if (action.action === "handback") return Response.json({ state: "live" });
      return Response.json({ state: "paused", controlling: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BrowserPanel sessionId="default" />);
    expect(await screen.findByText(live.url)).toBeTruthy();
    const image = screen.getByRole("img", { name: "Browser viewport" });
    fireEvent.click(image, { clientX: 150, clientY: 105 });
    expect(sent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/browser", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));

    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(await screen.findByText(/You’re in control/)).toBeTruthy();
    const viewport = screen.getByRole("img", { name: "Browser viewport" });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 70, 500, 350));
    await act(async () => fireEvent.click(viewport, { detail: 1, clientX: 150, clientY: 105 }));
    const wheel = new WheelEvent("wheel", { deltaX: 15, deltaY: 100, cancelable: true });
    Object.defineProperties(wheel, { clientX: { value: 150 }, clientY: { value: 105 } });
    await act(async () => fireEvent(viewport, wheel));
    expect(wheel.defaultPrevented).toBe(true);

    const text = screen.getByLabelText<HTMLInputElement>("Text to send");
    fireEvent.change(text, { target: { value: "fixture text" } });
    await act(async () => fireEvent.submit(text.form!));
    expect(text.value).toBe("");
    fireEvent.change(screen.getByLabelText("Key to press"), { target: { value: "PageDown" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send key" })));
    expect(sent).toEqual([
      { action: "takeover" },
      { action: "input", input: { kind: "click", x: 100, y: 70 } },
      { action: "input", input: { kind: "scroll", x: 100, y: 70, deltaX: 30, deltaY: 200 } },
      { action: "input", input: { kind: "text", text: "fixture text" } },
      { action: "input", input: { kind: "key", key: "PageDown" } },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Hide browser preview" }));
    expect(screen.queryByRole("img", { name: "Browser viewport" })).toBeNull();
    expect(screen.queryByLabelText("Text to send")).toBeNull();
    expect(screen.getByRole("button", { name: "Hand back" })).toBeTruthy();
    expect(screen.getByText(live.url)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show browser preview" }));
    expect(screen.getByRole("img", { name: "Browser viewport" })).toBeTruthy();
    expect(sent).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    await screen.findByRole("button", { name: "Take over" });
    expect(screen.queryByLabelText("Text to send")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop browser" }));
    expect(await screen.findByText("Closed")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Browser viewport" })).toBeNull();
    expect(sent.slice(-2)).toEqual([{ action: "handback" }, { action: "stop" }]);
  });

  it("refreshes every 1.75 seconds, scopes a named session, and never controls someone else’s pause", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_path: string) => Response.json({ state: "none" }));
    fetchMock.mockResolvedValueOnce(Response.json({ state: "none" }));
    fetchMock.mockResolvedValueOnce(Response.json({ ...live, state: "paused", controlling: false }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<BrowserPanel sessionId="thread-1" />);
    await act(async () => {});
    expect(screen.getByText("No session")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1749));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/sessions/browser?session=thread-1", "/api/sessions/browser?session=thread-1",
    ]);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
    expect(screen.queryByLabelText("Text to send")).toBeNull();

    view.rerender(<BrowserPanel sessionId="thread 2" />);
    expect(screen.queryByText(live.url)).toBeNull();
    await act(async () => {});
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/sessions/browser?session=thread%202");
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(1750));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not let a poll begun before takeover override the action result", async () => {
    vi.useFakeTimers();
    let stale!: (response: Response) => void;
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === "POST" ? Response.json({ state: "paused", controlling: true }) : Response.json(live),
    );
    fetchMock.mockResolvedValueOnce(Response.json(live));
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { stale = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BrowserPanel sessionId="default" />);
    await act(async () => vi.advanceTimersByTimeAsync(1750));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Take over" })));
    await act(async () => stale(Response.json(live)));
    expect(screen.getByRole("button", { name: "Hand back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });
});
