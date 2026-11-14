// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimaryBotPicker } from "./PrimaryBotPicker";

const agents = [{ slug: "fixer", name: "Fixer" }, { slug: "reviewer", name: "Reviewer" }];
const response = (actorId: string, source = "saved") => Response.json({ actorId, source });
const picker = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Primary bot" });

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrimaryBotPicker", () => {
  it("loads the saved value once and prevents changes until it is known", async () => {
    const pending = pendingResponse();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetch);
    render(<PrimaryBotPicker workspaceId="ws_first" agents={agents} />);
    expect(picker().disabled).toBe(true);
    fireEvent.focus(picker());
    fireEvent.focus(picker());
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(response("agent:fixer", "default")));
    await waitFor(() => expect(picker().value).toBe("agent:fixer"));
    expect(picker().disabled).toBe(false);
    expect(screen.getByText(/Using the earliest saved bot/)).toBeDefined();
  });

  it.each(["http", "network"])("restores the confirmed value after a %s save failure", async (failure) => {
    const fetch = vi.fn().mockResolvedValueOnce(response("agent:fixer"));
    if (failure === "http") fetch.mockResolvedValueOnce(Response.json({ error: "Save denied." }, { status: 403 }));
    else fetch.mockRejectedValueOnce(new Error("Disconnected"));
    vi.stubGlobal("fetch", fetch);
    render(<PrimaryBotPicker workspaceId="ws_first" agents={agents} />);
    await waitFor(() => expect(picker().value).toBe("agent:fixer"));
    fireEvent.change(picker(), { target: { value: "agent:reviewer" } });
    await screen.findByRole("alert");
    expect(picker().value).toBe("agent:fixer");
    expect(picker().disabled).toBe(false);
  });

  it("prevents concurrent saves and applies the server's confirmed result", async () => {
    const pending = pendingResponse();
    const fetch = vi.fn().mockResolvedValueOnce(response("agent:fixer")).mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetch);
    render(<PrimaryBotPicker workspaceId="ws_first" agents={agents} />);
    await waitFor(() => expect(picker().value).toBe("agent:fixer"));
    fireEvent.change(picker(), { target: { value: "agent:reviewer" } });
    expect(picker().disabled).toBe(true);
    fireEvent.change(picker(), { target: { value: "agent:fixer" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(response("agent:reviewer")));
    await waitFor(() => expect(picker().value).toBe("agent:reviewer"));
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ actorId: "agent:reviewer" }),
    });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("X-Shiba-Workspace")).toBe("ws_first");
  });

  it("discards requests and state from the previous workspace", async () => {
    const previous = pendingResponse();
    const current = pendingResponse();
    const fetch = vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<PrimaryBotPicker workspaceId="ws_first" agents={agents} />);
    rerender(<PrimaryBotPicker workspaceId="ws_second" agents={agents} />);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(picker().value).toBe("");
    await act(async () => current.resolve(response("agent:reviewer")));
    await waitFor(() => expect(picker().value).toBe("agent:reviewer"));
    await act(async () => previous.resolve(response("agent:fixer")));
    expect(picker().value).toBe("agent:reviewer");
  });

  it("lets a failed initial load be retried", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValueOnce(response("agent:fixer"));
    vi.stubGlobal("fetch", fetch);
    render(<PrimaryBotPicker workspaceId="ws_first" agents={agents} />);
    await screen.findByRole("alert");
    expect(picker().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading primary bot" }));
    await waitFor(() => expect(picker().value).toBe("agent:fixer"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
