// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FounderAutomaticReadInput, FounderAutomaticReadState } from "@shiba/shared";
import { FounderAutomaticReads } from "./FounderAutomaticReads";
import { AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, AUTOMATIC_BASE, automaticInput, automaticOptions, automaticGrant, automaticState, automaticOccurrence, automaticReport } from "../founder-automatic-fixtures";
import { automaticSlackState } from "../founder-automatic-slack-fixtures";
const props = { workspaceId: AUTOMATIC_WORKSPACE, libraryId: AUTOMATIC_LIBRARY, name: "Scheduled evidence", onClose: vi.fn() };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const expiry = () => { const at = new Date(Date.now() + 86_400_000); return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
function enabled() { const grant = automaticGrant(); return { ...grant, version: 2, state: "enabled" as const, canEnable: false, canPause: true }; }
function fixture(initial = automaticState()) {
  let state = initial, revoked = false; const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (revoked) return Response.json({ error: "source_revoked" }, { status: 403 });
    if (path.endsWith("/options")) return Response.json(automaticOptions());
    if (path.includes("/report/download")) return new Response(automaticReport(state.occurrences[0]).markdown);
    if (path.endsWith("/report")) return Response.json(automaticReport(state.occurrences[0]));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ path, body });
      if (path === AUTOMATIC_BASE) state = automaticState(automaticGrant(body as FounderAutomaticReadInput));
      else if (state.grant) {
        const next = path.endsWith("/pause") ? "paused" : path.endsWith("/revoke") ? "revoked" : "enabled";
        state = { ...state, grant: { ...state.grant, version: state.grant.version + 1, state: next, canEnable: false, canPause: next === "enabled", canResume: next === "paused", canRevoke: next !== "revoked" } };
      }
    }
    return Response.json(state);
  }); vi.stubGlobal("fetch", fetcher);
  return { writes, fetcher, revoke: () => { revoked = true; }, set: (value: FounderAutomaticReadState) => { state = value; } };
}
async function fillDraft() {
  fireEvent.click(await screen.findByText("Configure a new exact standing-read draft"));
  fireEvent.change(screen.getByLabelText("Scheduled employee version"), { target: { value: "employee-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Add explicit read step" }));
  fireEvent.change(screen.getByLabelText("Source account 1"), { target: { value: "account-github" } });
  fireEvent.change(screen.getByLabelText("Audited operation 1"), { target: { value: "github.list_pull_requests" } });
  fireEvent.change(screen.getByLabelText("Exact fixed arguments JSON 1"), { target: { value: JSON.stringify(automaticInput().operations[0]!.arguments) } });
  fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "daily" } }); fireEvent.change(screen.getByLabelText("Local time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("IANA timezone"), { target: { value: "UTC" } }); fireEvent.change(screen.getByLabelText("Absolute standing-grant expiry"), { target: { value: expiry() } });
  for (const [label, value] of [["Maximum scheduled occurrences", "2"], ["Maximum provider calls", "2"], ["Maximum captured bytes for this grant", "65536"], ["Maximum bytes per occurrence", "32768"]]) fireEvent.change(screen.getByLabelText(label!), { target: { value } });
}
describe("explicit bounded standing-read setup", () => {
  it("opens separate future Slack authority only for the explicitly selected completed report and clears it on source change", async () => {
    const grant = enabled(), occurrence = automaticOccurrence(grant), report = automaticReport(occurrence); let denied = false;
    const send = vi.fn(async (input: RequestInfo | URL) => {
      if (denied) return new Response("source unavailable", { status: 403 });
      const path = String(input); return Response.json(path.endsWith("/automatic-slack") ? automaticSlackState(null)
        : path.endsWith("/options") ? automaticOptions() : path.endsWith("/report") ? report : automaticState(grant, [occurrence]));
    }); vi.stubGlobal("fetch", send); render(<FounderAutomaticReads {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: `Read private scheduled report ${occurrence.id}` })); await screen.findByTestId("automatic-report");
    expect(send.mock.calls.some(([path]) => String(path).endsWith("/automatic-slack"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Review separate future Slack delivery" }));
    await screen.findByRole("region", { name: "Automatic founder reports to Slack" }); await screen.findByText(/Selected completed sample fao-fixture/);
    expect(send.mock.calls.filter(([path]) => String(path).endsWith("/automatic-slack"))).toHaveLength(1);
    denied = true; fireEvent.click(screen.getByRole("button", { name: "Refresh scheduled-read access" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Automatic founder reports to Slack" })).toBeNull());
    expect(screen.queryByTestId("automatic-report")).toBeNull();
  });
  it("shows missing attestation as unavailable and performs no mutating or provider action", async () => {
    const state = { ...automaticState(), available: false, canConfigure: false, unavailableReason: "read_gateway_attestation_missing" };
    const fetcher = vi.fn(async (path: RequestInfo | URL) => Response.json(String(path).endsWith("/options") ? { ...automaticOptions(), available: false, runtime: null } : state)); vi.stubGlobal("fetch", fetcher);
    render(<FounderAutomaticReads {...props} />); await screen.findByText(/Scheduled reads are unavailable: read_gateway_attestation_missing/);
    expect(screen.queryByText("Configure a new exact standing-read draft")).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("chooses no account or budgets, then saves a draft and requires both standing-read and quota consent", async () => {
    const f = fixture(); render(<FounderAutomaticReads {...props} />);
    fireEvent.click(await screen.findByText("Configure a new exact standing-read draft"));
    expect(screen.getByLabelText("Scheduled employee version")).toHaveProperty("value", ""); expect(screen.getByLabelText("Maximum provider calls")).toHaveProperty("value", ""); expect(f.writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Add explicit read step" })); expect(screen.getByLabelText("Source account 1")).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Remove read step 1" })); fireEvent.click(screen.getByText("Configure a new exact standing-read draft"));
    await fillDraft(); fireEvent.click(screen.getByRole("button", { name: "Prepare exact standing-read review" }));
    const enable = await screen.findByRole("button", { name: "Enable exact bounded scheduled reads" }); expect(enable).toHaveProperty("disabled", true); expect(f.writes).toHaveLength(1); expect(f.writes[0]?.path).toBe(AUTOMATIC_BASE);
    expect(screen.getByTestId("automatic-contract").textContent).toContain('"kind": "schedule"');
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed these exact source accounts/ })); expect(enable).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I authorize the selected provider requests/ })); fireEvent.click(enable); fireEvent.click(enable);
    await screen.findByText("Standing-read grant: enabled · v2"); expect(f.writes).toHaveLength(2); expect(f.writes[1]?.body).toMatchObject({ readConsent: "allow-exact-scheduled-read-operations-and-bounded-provider-calls", quotaConsent: "provider-requests-may-use-account-quota-or-incur-charges", expectedVersion: 1 });
    expect(f.writes.every((item) => !/slack|execute|approve/.test(item.path))).toBe(true);
  });
  it("pauses without requesting new read authority and requires fresh consent before resume", async () => {
    const f = fixture(automaticState(enabled())); render(<FounderAutomaticReads {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause scheduled reads" }));
    const resume = await screen.findByRole("button", { name: "Resume exact bounded scheduled reads" }); expect(resume).toHaveProperty("disabled", true);
    expect(f.writes[0]?.body).toEqual({ expectedVersion: 2, digest: "e".repeat(64), reviewed: true });
  });
  it("does not fabricate per-occurrence human approval or retry unknown work", async () => {
    const grant = enabled(), occurrence = { ...automaticOccurrence(grant), state: "unknown" as const, canReadReport: false, error: "uncertain_provider_outcome" };
    const f = fixture(automaticState(grant, [occurrence])); render(<FounderAutomaticReads {...props} />); await screen.findByText("uncertain_provider_outcome");
    expect(screen.queryByRole("button", { name: /Execute|Retry|Approve/ })).toBeNull(); expect(f.writes).toEqual([]);
  });
  it.each(["revoked", "blocked"] as const)("does not show a %s contract or inherited report even if a stale DTO contains its fields", async (state) => {
    const grant = { ...enabled(), state }, occurrence = automaticOccurrence(grant); const f = fixture(automaticState(grant, [occurrence]));
    render(<FounderAutomaticReads {...props} />); await screen.findByText("Configure a new exact standing-read draft");
    expect(screen.queryByTestId("automatic-contract")).toBeNull(); expect(screen.queryByRole("button", { name: /Read private scheduled report/ })).toBeNull(); expect(f.writes).toEqual([]);
  });
  it("clears frozen arguments and a private report after revoked-source focus refresh", async () => {
    const grant = enabled(), occurrence = automaticOccurrence(grant), f = fixture(automaticState(grant, [occurrence])); render(<FounderAutomaticReads {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: `Read private scheduled report ${occurrence.id}` })); await screen.findByTestId("automatic-report");
    f.revoke(); fireEvent(window, new Event("focus")); await screen.findByRole("alert"); expect(screen.queryByTestId("automatic-report")).toBeNull(); expect(screen.queryByTestId("automatic-contract")).toBeNull(); expect(f.writes).toEqual([]);
  });
  it("hides private arguments and report at exact grant expiry before polling, retaining only cleanup metadata", async () => {
    vi.useFakeTimers(); const grant = enabled(); grant.contract.expiresAt = Date.now() + 100; const occurrence = automaticOccurrence(grant); fixture(automaticState(grant, [occurrence]));
    await act(async () => { render(<FounderAutomaticReads {...props} />); }); fireEvent.click(screen.getByRole("button", { name: `Read private scheduled report ${occurrence.id}` }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(screen.getByTestId("automatic-report")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(101); }); expect(screen.queryByTestId("automatic-report")).toBeNull(); expect(screen.queryByTestId("automatic-contract")).toBeNull(); expect(screen.getByRole("button", { name: "Revoke unavailable scheduled-read grant" })).toBeTruthy();
  });
  it("discards late A download before any local Blob or click when the unkeyed wrapper switches to B", async () => {
    const grant = enabled(), occurrence = automaticOccurrence(grant), report = automaticReport(occurrence), foreign = `ws_${"b".repeat(24)}`;
    let finish!: (value: Response) => void; const late = new Promise<Response>((resolve) => { finish = resolve; });
    const blob = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture"), click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const scope = new Headers(init?.headers).get("X-Shiba-Workspace");
      if (String(input).includes("/download")) return late;
      if (String(input).endsWith("/report")) return Response.json(report);
      if (String(input).endsWith("/options")) return Response.json({ ...automaticOptions(), workspaceId: scope, connections: scope === foreign ? [] : automaticOptions().connections });
      return Response.json({ ...automaticState(scope === foreign ? null : grant, scope === foreign ? [] : [occurrence]), workspaceId: scope });
    }));
    const { rerender } = render(<FounderAutomaticReads {...props} />); fireEvent.click(await screen.findByRole("button", { name: `Read private scheduled report ${occurrence.id}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Download exact private scheduled report" })); rerender(<FounderAutomaticReads {...props} workspaceId={foreign} />);
    await screen.findByText("Configure a new exact standing-read draft"); await act(async () => { finish(new Response(report.markdown)); });
    expect(blob).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled(); expect(screen.queryByTestId("automatic-report")).toBeNull();
  });
  it("offers exact pointer revocation without exposing private contract when the server returns only stale metadata", async () => {
    const grant = automaticGrant(); const f = fixture({ ...automaticState(), available: false, canConfigure: false, staleGrant: { id: grant.id, version: 1, digest: grant.digest, state: "blocked", canRevoke: true } });
    f.fetcher.mockImplementation(async (_input, init) => {
      if (init?.method === "POST") f.writes.push({ path: String(_input), body: JSON.parse(String(init.body)) });
      return Response.json(String(_input).endsWith("/options") ? { ...automaticOptions(), available: false } : { ...automaticState(), available: false, canConfigure: false, staleGrant: { id: grant.id, version: init?.method === "POST" ? 2 : 1, digest: grant.digest, state: init?.method === "POST" ? "revoked" : "blocked", canRevoke: init?.method !== "POST" } });
    }); render(<FounderAutomaticReads {...props} />); fireEvent.click(await screen.findByRole("button", { name: "Revoke unavailable scheduled-read grant" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke unavailable scheduled-read grant" })).toBeNull()); expect(screen.queryByTestId("automatic-contract")).toBeNull(); expect(f.writes[0]?.body).toEqual({ expectedVersion: 1, digest: grant.digest, reviewed: true });
  });
});
