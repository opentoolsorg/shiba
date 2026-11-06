// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FounderEvidenceInput, FounderEvidencePreview, FounderEvidenceRecord } from "@shiba/shared";
import { founderEvidenceReportHash } from "@shiba/shared";
import { FounderEvidenceReports } from "./FounderEvidenceReports";
import { EVIDENCE_WORKSPACE, EVIDENCE_LIBRARY, EVIDENCE_BASE, evidenceOptions, evidencePreview, evidenceRecord, evidenceSummary } from "../founder-evidence-fixtures";
const props = { workspaceId: EVIDENCE_WORKSPACE, libraryId: EVIDENCE_LIBRARY, name: "Evidence", onClose: vi.fn() };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const expiryText = () => { const at = new Date(Date.now() + 3_600_000); return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
async function selectSources() {
  fireEvent.change(await screen.findByRole("combobox", { name: "Employee version" }), { target: { value: "employee-one" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: /^stripe/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^hubspot/ }));
  fireEvent.change(screen.getByLabelText(/Absolute expiry/), { target: { value: expiryText() } });
}
function fixture() {
  let preview: FounderEvidencePreview | null = null, record: FounderEvidenceRecord | null = null;
  let revoked = false, changed = false;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (revoked) return Response.json({ error: "source_revoked" }, { status: 403 });
    if (path.includes("/options")) {
      const value = evidenceOptions(path.includes("employeeId="));
      if (changed) value.receipts = value.receipts.map((item) => ({ ...item, resultDigest: "9".repeat(64) }));
      return Response.json(value);
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ path, body });
      if (path.endsWith("/preview")) { preview = evidencePreview(body as FounderEvidenceInput); return Response.json(preview); }
      if (path.endsWith("/revoke")) return Response.json({ ...evidenceOptions(), report: { ...evidenceSummary(record!), state: "revoked", canRead: false, canRevoke: false } });
      record = evidenceRecord(preview!); return Response.json(record, { status: 201 });
    }
    if (path.includes("/download?")) return new Response(path.endsWith("format=json") ? record!.json : record!.markdown);
    if (path === `${EVIDENCE_BASE}/fer-fixture`) return Response.json(record);
    return Response.json({ ...evidenceOptions(), reports: record ? [evidenceSummary(record)] : [] });
  });
  vi.stubGlobal("fetch", fetcher);
  return { writes, fetcher, revoke: () => { revoked = true; }, change: () => { changed = true; }, setRecord: (value: FounderEvidenceRecord) => { record = value; } };
}

describe("private founder evidence reports", () => {
  it("selects explicit stored excerpts, previews exact hash and creates privately only after human review", async () => {
    const f = fixture(); render(<FounderEvidenceReports {...props} />);
    const preview = await screen.findByRole("button", { name: "Preview private evidence report" });
    expect((preview as HTMLButtonElement).disabled).toBe(true); expect(f.writes).toEqual([]);
    await selectSources(); fireEvent.click(preview);
    await screen.findByTestId("evidence-content");
    expect(f.writes).toHaveLength(1); expect(f.writes[0]?.path).toBe(`${EVIDENCE_BASE}/preview`);
    expect(screen.getByText(/No MRR, churn, reconciliation or financial conclusions/)).toBeTruthy();
    expect(screen.getAllByText(/Bounded stored excerpt\. Capture completeness: unknown/)).toHaveLength(2);
    expect(screen.getByTestId("evidence-content").textContent).toContain("Stored result: null (no stored value)");
    const create = screen.getByRole("button", { name: "Create reviewed private report" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed these exact stored excerpts/ }));
    fireEvent.click(create); fireEvent.click(create);
    await screen.findByRole("button", { name: "Download verified report" });
    expect(f.writes).toHaveLength(2); expect(f.writes[1]?.path).toBe(EVIDENCE_BASE);
    expect(f.writes[1]?.body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.writes[1]?.body.expectedReportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.fetcher.mock.calls.every(([path]) => String(path).startsWith(EVIDENCE_BASE))).toBe(true);
    expect(f.fetcher.mock.calls.some(([path]) => String(path).includes("/download"))).toBe(false);
    expect(f.fetcher.mock.calls.some(([path]) => String(path).endsWith("/slack"))).toBe(false);
  });
  it("clears selected receipts and preview after a source hash changes on focus refresh", async () => {
    const f = fixture(); render(<FounderEvidenceReports {...props} />); await selectSources();
    fireEvent.click(screen.getByRole("button", { name: "Preview private evidence report" })); await screen.findByTestId("evidence-content");
    f.change(); fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.queryByTestId("evidence-content")).toBeNull());
    expect(screen.getByText(/Selected 0 of 8/)).toBeTruthy(); expect(f.writes).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Create reviewed private report" })).toBeNull();
  });
  it("removes saved private output and selections when source access is revoked", async () => {
    const f = fixture(), record = evidenceRecord(); f.setRecord(record); render(<FounderEvidenceReports {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open private report fer-fixture" })); await screen.findByTestId("evidence-content");
    f.revoke(); fireEvent(window, new Event("focus")); await screen.findByRole("alert");
    expect(screen.queryByTestId("evidence-content")).toBeNull(); expect(screen.queryByRole("button", { name: "Download verified report" })).toBeNull();
  });
  it("does not create a Blob, download or clipboard call for a late A response after switching to B", async () => {
    const record = evidenceRecord(), foreign = `ws_${"b".repeat(24)}`;
    let finish!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => { finish = resolve; });
    const createObjectURL = vi.fn(() => "blob:fixture"), revokeObjectURL = vi.fn();
    const NativeURL = URL; vi.stubGlobal("URL", class extends NativeURL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const copy = vi.fn(); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    const calls: Array<{ workspace: string | null; signal?: AbortSignal | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const workspaceId = new Headers(init?.headers).get("X-Shiba-Workspace"); calls.push({ workspace: workspaceId, signal: init?.signal });
      if (String(input).includes("/download?")) return late;
      if (String(input).includes("/options")) return Response.json({ ...evidenceOptions(), workspaceId });
      if (String(input).endsWith("/fer-fixture")) return Response.json(record);
      return Response.json({ ...evidenceOptions(), workspaceId, reports: workspaceId === foreign ? [] : [evidenceSummary(record)] });
    }));
    const { rerender } = render(<FounderEvidenceReports {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open private report fer-fixture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download verified report" }));
    rerender(<FounderEvidenceReports {...props} workspaceId={foreign} />);
    await screen.findByRole("combobox", { name: "Employee version" });
    await act(async () => finish(new Response(record.markdown)));
    expect(createObjectURL).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("evidence-content")).toBeNull();
    expect(calls.filter((item) => item.workspace === EVIDENCE_WORKSPACE).every((item) => item.signal?.aborted)).toBe(true);
  });
  it("hides a saved report at its exact local expiry without waiting for a poll", async () => {
    vi.useFakeTimers();
    const f = fixture(), record = evidenceRecord(); record.expiresAt = Date.now() + 100; record.reportHash = founderEvidenceReportHash(record); f.setRecord(record);
    render(<FounderEvidenceReports {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Open private report fer-fixture" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(screen.getByTestId("evidence-content")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(101); });
    expect(screen.queryByTestId("evidence-content")).toBeNull(); expect(screen.queryByRole("button", { name: "Download verified report" })).toBeNull();
  });
  it("requires current owned active skill and never auto-selects receipts to fill missing data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("/options") ? { ...evidenceOptions(), skill: null } : { ...evidenceOptions(), reports: [] }));
    vi.stubGlobal("fetch", fetcher); render(<FounderEvidenceReports {...props} />);
    await screen.findByText(/Install, review and activate this founder skill/);
    expect((screen.getByRole("button", { name: "Preview private evidence report" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("requires a new explicit Slack disclosure opening when another saved report is selected", async () => {
    const first = evidenceRecord(), second = { ...first, id: "fer-second" };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input); calls.push(path);
      if (path.endsWith("/slack")) return Response.json({ ok: true, workspaceId: EVIDENCE_WORKSPACE, libraryId: EVIDENCE_LIBRARY, actorId: first.actorId, reportId: first.id, available: false, destinations: [], intents: [] });
      if (path.includes("/options")) return Response.json(evidenceOptions());
      if (path.endsWith("/fer-fixture")) return Response.json(first);
      if (path.endsWith("/fer-second")) return Response.json(second);
      return Response.json({ ...evidenceOptions(), reports: [evidenceSummary(first), evidenceSummary(second)] });
    }));
    render(<FounderEvidenceReports {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open private report fer-fixture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review separate Slack disclosure" }));
    await screen.findByText(/Slack disclosure is unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Open private report fer-second" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Review report disclosure to Slack" })).toBeNull());
    await screen.findByRole("button", { name: "Download verified report" });
    expect(calls.filter((path) => path.endsWith("/slack"))).toEqual([`${EVIDENCE_BASE}/fer-fixture/slack`]);
  });
});
