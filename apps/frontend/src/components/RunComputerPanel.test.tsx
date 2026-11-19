// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunComputerPanel } from "./RunComputerPanel";

const frame = "iVBORw0KGgo=";
const runId = "web:owner/a";
const sessionId = "session & one";
const url = "/api/runs/web%3Aowner%2Fa/screen?session=session+%26+one";
const actionRequest = (body: object) => expect.objectContaining({ method: "POST", body: JSON.stringify(body) });
const screenResponse = (control: "agent" | "you" | "other" = "agent") =>
  Response.json({ ok: true, control, screenshotBase64: frame });
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("RunComputerPanel", () => {
  it("watches, takes control, maps displayed points to desktop pixels, sends input and releases", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.action?.type === "shot") return screenResponse();
      return Response.json({ ok: true, control: body.control === "release" ? "agent" : "you" });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<RunComputerPanel runId={runId} sessionId={sessionId} status="running" />);
    await flush();
    const image = screen.getByRole<HTMLImageElement>("img", { name: "Live view of the run desktop" });
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${frame}`);
    expect(fetcher).toHaveBeenCalledWith(url, actionRequest({ action: { type: "shot" } }));
    const viewport = screen.getByRole<HTMLButtonElement>("button", { name: "Cloud computer screen" });
    expect(viewport.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await flush();
    expect(screen.getByText("You have control")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith(url, actionRequest({ control: "take" }));
    expect(viewport.disabled).toBe(false);
    Object.defineProperties(image, { naturalWidth: { value: 1280 }, naturalHeight: { value: 800 } });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(80, 20, 640, 400));
    fireEvent.click(viewport, { clientX: 400, clientY: 120, detail: 1 });
    fireEvent.contextMenu(viewport, { clientX: 719, clientY: 419 });
    fireEvent.keyDown(viewport, { key: "ArrowDown", ctrlKey: true });
    fireEvent.keyDown(viewport, { key: "Tab" });
    fireEvent.wheel(viewport, { deltaX: -120, deltaY: 240 });
    const text = screen.getByRole("textbox", { name: "Text to send to the cloud computer" });
    fireEvent.change(text, { target: { value: "Hello, world" } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    await flush();
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body))).slice(2)).toEqual([
      { action: { type: "click", x: 640, y: 200, button: "left" } },
      { action: { type: "click", x: 1278, y: 798, button: "right" } },
      { action: { type: "key", keys: "ctrl+Down" } },
      { action: { type: "scroll", dx: -120, dy: 240 } },
      { action: { type: "type", text: "Hello, world" } },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    await flush();
    expect(screen.getByText("Agent has control")).toBeTruthy();
    expect(fetcher).toHaveBeenLastCalledWith(url, actionRequest({ control: "release" }));
    expect(viewport.disabled).toBe(true);
  });

  it("respects another controller, including a conflict while taking control", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(screenResponse())
      .mockResolvedValueOnce(Response.json({ control: "other" }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    render(<RunComputerPanel runId={runId} status="running" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await flush();
    expect(screen.getByText("Someone else has control")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take control" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cloud computer screen" }).disabled).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("waits for each frame request, then stops polling and clears the frame when the run closes", async () => {
    let reply: (response: Response) => void = () => {};
    const fetcher = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { reply = resolve; }))
      .mockResolvedValueOnce(Response.json({ error: "Only a running run has a live screen." }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    render(<RunComputerPanel runId={runId} status="running" />);
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { reply(screenResponse()); });
    expect(screen.getByRole("img")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText("This cloud computer is closed.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not open a pending desktop and aborts the previous scope when the run changes", async () => {
    const fetcher = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<RunComputerPanel runId={runId} status="pending" />);
    expect(screen.getByText("The screen opens when the approved run starts.")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    rerender(<RunComputerPanel runId={runId} status="running" />);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const signal = fetcher.mock.calls[0]?.[1].signal;
    rerender(<RunComputerPanel runId="next" status="running" />);
    expect(signal?.aborted).toBe(true);
    await flush();
    expect(fetcher).toHaveBeenLastCalledWith("/api/runs/next/screen", actionRequest({ action: { type: "shot" } }));
  });
});
