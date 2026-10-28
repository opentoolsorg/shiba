// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadTitleEditor } from "./ThreadTitleEditor";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
  return screen.getByRole("textbox", { name: "Thread name" });
}

describe("thread rename", () => {
  it("persists a trimmed name through the scoped sessions API before updating the list", async () => {
    const onRenamed = vi.fn();
    let complete!: (value: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal("fetch", request);
    render(<ThreadTitleEditor sessionId="session-a" name="Old thread" onRenamed={onRenamed} />);
    fireEvent.change(openEditor(), { target: { value: "  Review authentication  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(request).toHaveBeenCalledWith("/api/sessions/session-a", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ name: "Review authentication" }),
    }));
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled")).toBe(true);
    complete(Response.json({ session: { id: "session-a", name: "Review authentication", updatedAt: 42 } }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith({ id: "session-a", name: "Review authentication", updatedAt: 42 }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the editor and old name after a failed request, then allows retry", async () => {
    const onRenamed = vi.fn();
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Session not found." }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ session: { id: "a", name: "New name", updatedAt: 1 } }));
    vi.stubGlobal("fetch", request);
    render(<ThreadTitleEditor sessionId="a" name="Old name" onRenamed={onRenamed} />);
    fireEvent.change(openEditor(), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Session not found."));
    expect(onRenamed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledOnce());
  });

  it("does not accept a response for a different thread", async () => {
    const onRenamed = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ session: { id: "another-thread", name: "Wrong", updatedAt: 1 } })));
    render(<ThreadTitleEditor sessionId="a" name="Old name" onRenamed={onRenamed} />);
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("did not confirm"));
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("disables blank names and cancels without making a request", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(<ThreadTitleEditor sessionId="a" name="Old name" onRenamed={vi.fn()} />);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save name" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not leak errors from a previous thread after navigation", async () => {
    let fail!: (cause: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject; })));
    const onRenamed = vi.fn();
    const { rerender } = render(<ThreadTitleEditor sessionId="a" name="First" onRenamed={onRenamed} />);
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    rerender(<ThreadTitleEditor sessionId="b" name="Second" onRenamed={onRenamed} />);
    fail(new Error("Old request failed"));
    await Promise.resolve();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not offer mutation of the protected default session", () => {
    const { container } = render(<ThreadTitleEditor sessionId="default" name="Default" onRenamed={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
