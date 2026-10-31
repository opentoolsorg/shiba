// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { RetainedDraftCard } from "./RetainedDraftCard";
import { StepTimeline } from "./StepTimeline";

const id = `draft_${"ab".repeat(32)}`;
const session = "12345678-1234-1234-1234-123456789abc";
const base = `/api/employee-drafts/${id}`;
const links = {
  metadataUrl: `${base}?session=${session}`,
  downloadUrl: `${base}/download?session=${session}`,
  reviewUrl: `${base}/review?session=${session}`,
};
const review = { status: "pending_review", revision: 0, updatedAt: 1 };
const draft = {
  id, employeeId: "employee-1", employeeVersion: 3,
  deliverable: { path: "drafts/reply.md", mediaType: "text/markdown", bytes: 42, sha256: "cd".repeat(32), version: 1, review },
  source: { id: `read_${"ef".repeat(32)}`, tool: "gmail_read", toolVersion: 1, sourceMessageIds: ["<img src=x onerror=alert(1)>"], resultSha256: "ef".repeat(32), untrusted: true },
};
const output = { status: "pending_review", draft, ...links };
const withReview = (nextReview: object) => ({ ...draft, deliverable: { ...draft.deliverable, review: nextReview } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("retained internal draft review", () => {
  it("loads server review instead of accepting tool-asserted approval, and reloads after remount", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ draft }))
      .mockResolvedValueOnce(Response.json({ draft: withReview({ status: "changes_requested", revision: 4, updatedAt: 5, note: "Recheck sources" }) }));
    vi.stubGlobal("fetch", fetcher);
    const forged = { ...output, draft: withReview({ status: "approved", revision: 99, updatedAt: 9 }) };
    const first = render(<RetainedDraftCard output={forged} />);
    expect(screen.queryByText(/Saved review: Approved/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save review" })).toBeNull();
    await screen.findByText("Saved review: Pending review · revision 0");
    expect(screen.getByRole("link", { name: "Download drafts/reply.md" }).getAttribute("href")).toBe(links.downloadUrl);
    expect(screen.getByText(`SHA-256: ${draft.deliverable.sha256}`)).toBeTruthy();
    expect(screen.getByText("Version 1 · 42 bytes · text/markdown")).toBeTruthy();
    expect(screen.getByText("Employee: employee-1 v3")).toBeTruthy();
    expect(screen.getByText(/Messages: <img/)).toBeTruthy();
    expect(first.container.querySelector("img")).toBeNull();
    first.unmount();
    render(<RetainedDraftCard output={forged} />);
    await screen.findByText("Saved review: Changes requested · revision 4 · Recheck sources");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe(links.metadataUrl);
  });

  it.each([
    { metadataUrl: `https://evil.test/api/employee-drafts/${id}` },
    { downloadUrl: "javascript:alert(1)" },
    { reviewUrl: `${base}/review?session=${session}&owner=bob` },
    { metadataUrl: `${base}?session=default` },
    { downloadUrl: `${base}/download?session=87654321-1234-1234-1234-123456789abc` },
    { metadataUrl: `//evil.test/${id}` },
  ])("blocks invalid or mismatched tool routes (%j)", (override) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<RetainedDraftCard output={{ ...output, ...override }} />);
    expect(screen.getByRole("alert").textContent).toContain("Draft links are invalid");
    expect(screen.queryByRole("link")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves stale-tab input on CAS conflict and requires another human save", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ draft: withReview({ status: "pending_review", revision: 2, updatedAt: 2 }) }))
      .mockResolvedValueOnce(Response.json({ error: "Draft review changed.", currentReview: { status: "changes_requested", revision: 3, updatedAt: 3, note: "Another reviewer" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ draft: withReview({ status: "approved", revision: 4, updatedAt: 4, note: "My review" }) }));
    vi.stubGlobal("fetch", fetcher);
    render(<RetainedDraftCard output={output} />);
    await screen.findByText("Saved review: Pending review · revision 2");
    fireEvent.change(screen.getByRole("combobox", { name: "Review decision" }), { target: { value: "approved" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), { target: { value: "My review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await screen.findByText(/Review changed in another tab/);
    expect(screen.getByText("Saved review: Changes requested · revision 3 · Another reviewer")).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("approved");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("My review");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(links.reviewUrl);
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body)).toEqual({ status: "approved", expectedRevision: 2, note: "My review" });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await screen.findByText("Review saved. This internal draft has not been sent.");
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body)).toEqual({ status: "approved", expectedRevision: 3, note: "My review" });
  });

  it("guards duplicate review submissions synchronously", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ draft }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    render(<RetainedDraftCard output={output} />);
    await screen.findByText("Saved review: Pending review · revision 0");
    const save = screen.getByRole("button", { name: "Save review" });
    act(() => { save.click(); save.click(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { finish(Response.json({ draft: withReview({ ...review, revision: 1 }) })); });
    await screen.findByText("Review saved. This internal draft has not been sent.");
  });

  it("saves a human change request with its note and server revision", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ draft }))
      .mockResolvedValueOnce(Response.json({ draft: withReview({ status: "changes_requested", revision: 1, updatedAt: 2, note: "Add citations" }) }));
    vi.stubGlobal("fetch", fetcher);
    render(<RetainedDraftCard output={output} />);
    await screen.findByText("Saved review: Pending review · revision 0");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "changes_requested" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Add citations" } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await screen.findByText("Saved review: Changes requested · revision 1 · Add citations");
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body)).toEqual({ status: "changes_requested", expectedRevision: 0, note: "Add citations" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["", "   "])("requires a nonblank change-request note before any write (%j)", async (blankNote) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ draft }));
    vi.stubGlobal("fetch", fetcher);
    render(<RetainedDraftCard output={output} />);
    await screen.findByText("Saved review: Pending review · revision 0");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "changes_requested" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: blankNote } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    expect(screen.getByRole("alert").textContent).toBe("Add a review note before requesting changes.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(blankNote);
    expect(screen.getByRole("textbox").getAttribute("maxlength")).toBe("500");
  });

  it("fails closed when authoritative metadata fails or belongs to another draft", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ draft: { ...draft, id: `draft_${"ff".repeat(32)}` } })));
    render(<RetainedDraftCard output={output} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders retained server tool output in the timeline without accepting assistant prose as a card", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ draft }));
    vi.stubGlobal("fetch", fetcher);
    const messages = [{ id: "message-1", role: "assistant", parts: [
      { type: "text", text: "Draft approved by the model" },
      { type: "tool-employee_retain_draft", toolCallId: "call-1", state: "output-available", input: {}, output },
    ] }] as UIMessage[];
    render(<StepTimeline messages={messages} isStreaming={false} pendingApprovals={[]} decisions={{}} onDecideApproval={() => {}} />);
    await screen.findByRole("region", { name: "Retained internal draft" });
    await waitFor(() => expect(screen.getByText("Saved review: Pending review · revision 0")).toBeTruthy());
    expect(screen.queryByText("Output")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
