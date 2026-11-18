// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFactsSettings } from "./WorkspaceFacts";

const ENDPOINT = "/api/admin/workspace-facts";
const fact = { id: "fact-1", team_id: "T1", connection_id: "legacy", fact: "Alex owns billing", created_by: "employee-1", source_channel: "C1", created_at: 1700000000000 };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Workspace facts settings", () => {
  it("groups facts by workspace and connection and renders notes as text with metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ facts: [fact,
      { ...fact, id: "fact-2", fact: "Maya owns search" },
      { ...fact, id: "fact-3", connection_id: "retained", fact: "<script>not HTML</script>" },
      { ...fact, id: "fact-4", team_id: "T2", fact: "Other team note" },
    ] })));
    render(<WorkspaceFactsSettings />);
    const group = await screen.findByRole("region", { name: "Slack workspace T1, connection legacy" });
    expect(within(group).getByText("Alex owns billing")).toBeTruthy();
    expect(within(group).getByText("Maya owns search")).toBeTruthy();
    expect(within(group).getAllByText(/Saved by employee-1 · Channel C1/)).toHaveLength(2);
    expect(screen.getAllByRole("region")).toHaveLength(3);
    expect(screen.getByText("<script>not HTML</script>").querySelector("script")).toBeNull();
  });

  it("explains saving and retention when the list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ facts: [] })));
    render(<WorkspaceFactsSettings />);
    expect(await screen.findByText("No workspace facts saved yet.")).toBeTruthy();
    expect(screen.getByText("channel_remember")).toBeTruthy();
    expect(screen.getByText(/Facts are kept if Slack is disconnected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("requires confirmation, deletes the selected id and reloads", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ facts: [fact] }))
      .mockResolvedValueOnce(Response.json({ deleted: true }))
      .mockResolvedValueOnce(Response.json({ facts: [] }));
    vi.stubGlobal("fetch", fetcher);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<WorkspaceFactsSettings />);
    const button = await screen.findByRole("button", { name: "Delete fact fact-1" });
    fireEvent.click(button);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Alex owns billing"));
    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await screen.findByText("No workspace facts saved yet.");
    expect(fetcher).toHaveBeenCalledWith(`${ENDPOINT}/fact-1`, { method: "DELETE" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shows a useful 403 error instead of an empty list and supports retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ facts: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(<WorkspaceFactsSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("deployment admin operator");
    expect(screen.queryByText("No workspace facts saved yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No workspace facts saved yet.");
  });

  it.each([403, 500])("reports delete errors (%s) without claiming success", async (status) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ facts: [fact] }))
      .mockResolvedValueOnce(Response.json({}, { status }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<WorkspaceFactsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete fact fact-1" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(String(status)));
    expect(screen.queryByText("No workspace facts saved yet.")).toBeNull();
  });

  it("reports network errors instead of an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    render(<WorkspaceFactsSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("Network unavailable");
  });
});
