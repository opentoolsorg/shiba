// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThreadPause } from "../agent-threads";
import { AgentThreadList } from "./AgentThreadList";
import { PAUSED_THREAD_COPY, ThreadPauseControl } from "./ThreadPauseControl";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ThreadPauseControl", () => {
  it("pauses via PATCH and reports the returned session", async () => {
    const fetchMock = vi.fn(async () => Response.json({ session: { id: "s1", updatedAt: 5, pausedAt: 4 } }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<ThreadPauseControl sessionId="s1" paused={false} onChanged={onChanged} />);
    const button = screen.getByRole("button", { name: "Pause thread" });
    expect(button.className).toContain("min-h-11");
    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ id: "s1", updatedAt: 5, pausedAt: 4 }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ paused: true }) }));
  });

  it("shows the Paused badge, resumes, and surfaces a thread_paused error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "thread_paused" }, { status: 409 })));
    render(<ThreadPauseControl sessionId="s1" paused onChanged={vi.fn()} />);
    expect(screen.getByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume thread" }));
    expect((await screen.findByRole("alert")).textContent).toBe(PAUSED_THREAD_COPY);
  });

  it("renders nothing for the default thread", () => {
    const { container } = render(<ThreadPauseControl sessionId="default" paused={false} onChanged={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("paused thread state", () => {
  const base = { id: "a", name: "A", agentName: "web:u:a", updatedAt: 1 };

  it("applyThreadPause sets and clears pausedAt", () => {
    const paused = applyThreadPause([base], { id: "a", updatedAt: 2, pausedAt: 2 });
    expect(paused[0]?.pausedAt).toBe(2);
    expect(applyThreadPause(paused, { id: "a", updatedAt: 3 })[0]).not.toHaveProperty("pausedAt");
  });

  it("the thread list marks a paused thread", () => {
    render(<AgentThreadList agentName="Bot" threads={[{ ...base, pausedAt: 2 }]} onSelect={vi.fn()} />);
    expect(screen.getByText("Paused")).toBeTruthy();
  });
});
