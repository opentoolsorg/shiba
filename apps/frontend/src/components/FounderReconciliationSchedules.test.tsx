// @vitest-environment happy-dom
import { StrictMode } from "react";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderReconciliationSchedules } from "./FounderReconciliationSchedules";
import { SCHEDULE_ACTOR, SCHEDULE_WORKSPACE, scheduleScope, standingComparison, scheduledCapture } from "../founder-reconciliation-schedules-fixtures";
vi.mock("./FounderReconciliationAutomaticSlack", () => ({ FounderReconciliationAutomaticSlack: ({ sample }: { sample?: unknown }) => <output data-testid="combined-sharing-handoff">{JSON.stringify(sample)}</output> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("separate future private comparison consent", () => {
  it("opens sharing only after a verified private result and an explicit click", async () => {
    vi.stubGlobal("crypto", webcrypto); const f = await scheduledCapture();
    const send = vi.fn(async (path: RequestInfo | URL) => {
      if (String(path).includes("/results/")) return Response.json({ ...scheduleScope, report: f.report, digest: f.digest });
      if (String(path).endsWith(f.schedule.id)) return Response.json({ ...scheduleScope, schedule: f.schedule, results: [f.receipt] });
      if (String(path) === "/api/founder-reconciliations") return Response.json({ ...scheduleScope, drafts: [] });
      return Response.json({ ...scheduleScope, available: true, schedules: [{ id: f.schedule.id, digest: f.schedule.digest, state: f.schedule.state, expiresAt: f.schedule.expiresAt }] });
    });
    vi.stubGlobal("fetch", send);
    render(<FounderReconciliationSchedules workspaceId={SCHEDULE_WORKSPACE} actorId={SCHEDULE_ACTOR} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review standing comparison" }));
    fireEvent.click(await screen.findByRole("button", { name: "Read private scheduled result" }));
    const share = await screen.findByRole("button", { name: "Review future combined reports for Slack" });
    expect(screen.queryByTestId("combined-sharing-handoff")).toBeNull();
    fireEvent.click(share);
    expect(JSON.parse(screen.getByTestId("combined-sharing-handoff").textContent ?? "")).toEqual({ scheduleId: f.schedule.id, sampleResultId: f.receipt.id, sampleHash: f.digest, expiresAt: f.receipt.expiresAt, scheduleExpiresAt: f.schedule.expiresAt });
    expect(send.mock.calls.some(([path]) => String(path).includes("reconciliation-slack"))).toBe(false);
  });
  it("survives Strict Mode without issuing a standing grant", async () => {
    const send = vi.fn(async (path: RequestInfo | URL) => String(path) === "/api/founder-reconciliation-schedules" ? Response.json({ ...scheduleScope, available: false, schedules: [] }) : Response.json({ ...scheduleScope, drafts: [] }));
    vi.stubGlobal("fetch", send);
    render(<StrictMode><FounderReconciliationSchedules workspaceId={SCHEDULE_WORKSPACE} actorId={SCHEDULE_ACTOR} onClose={() => {}} /></StrictMode>);
    await screen.findByText(/Automatic comparisons are unavailable or disabled/);
    expect(screen.getByRole("button", { name: "Refresh future comparisons" })).toHaveProperty("disabled", false);
    expect(send.mock.calls.every(([path]) => !String(path).endsWith("/enable"))).toBe(true);
  });
  it("requires a new explicit standing consent after selecting the reference and bounds", async () => {
    const grant = standingComparison(); grant.expiresAt = Math.floor(grant.expiresAt / 60000) * 60000;
    const send = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/founder-reconciliations") return Response.json({ ...scheduleScope, drafts: [{ id: grant.sampleId, digest: "a".repeat(64), state: "completed", expiresAt: grant.reviewExpiresAt }] });
      if (String(path).endsWith("/enable")) return Response.json({ ...scheduleScope, schedule: { ...grant, state: "enabled", cutoffAt: Date.now(), nextDueAt: Date.now() + 3600000 } });
      return init?.method === "POST" ? Response.json({ ...scheduleScope, schedule: grant }) : Response.json({ ...scheduleScope, available: true, schedules: [] });
    });
    vi.stubGlobal("fetch", send);
    render(<FounderReconciliationSchedules workspaceId={SCHEDULE_WORKSPACE} actorId={SCHEDULE_ACTOR} sampleId={grant.sampleId} onClose={() => {}} />);
    await screen.findByText("Prepare a standing comparison review");
    fireEvent.change(screen.getByLabelText("Maximum future results"), { target: { value: String(grant.maxComparisons) } });
    fireEvent.change(screen.getByLabelText("Maximum capture skew (minutes)"), { target: { value: String(grant.maxSkewMinutes) } });
    const local = new Date(grant.expiresAt - new Date(grant.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText("Standing expiry (local time)"), { target: { value: local } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare future comparison review" }));
    const enable = await screen.findByRole("button", { name: "Enable future private comparisons" });
    expect(enable).toHaveProperty("disabled", true);
    expect(send.mock.calls.some(([path]) => String(path).endsWith("/enable"))).toBe(false);
    fireEvent.click(screen.getByLabelText(/I authorize future private comparisons/)); fireEvent.click(enable);
    await screen.findByText(/Future private comparisons enabled/);
    const request = send.mock.calls.find(([path]) => String(path).endsWith("/enable"));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ digest: grant.digest, reviewed: true, consent: "allow-future-private-reconciliation-comparisons" });
  });
  it("drops an old native account's pending private configuration", async () => {
    const grant = standingComparison(), next = "next@example.test"; let actor = SCHEDULE_ACTOR;
    let release!: (r: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => String(path).endsWith(grant.id) ? held : String(path) === "/api/founder-reconciliation-schedules" ? Response.json({ ...scheduleScope, actorId: actor, available: true, schedules: actor === SCHEDULE_ACTOR ? [{ id: grant.id, digest: grant.digest, state: grant.state, expiresAt: grant.expiresAt }] : [] }) : Response.json({ ...scheduleScope, actorId: actor, drafts: [] })));
    const view = render(<FounderReconciliationSchedules workspaceId={SCHEDULE_WORKSPACE} actorId={SCHEDULE_ACTOR} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review standing comparison" }));
    actor = next; view.rerender(<FounderReconciliationSchedules workspaceId={SCHEDULE_WORKSPACE} actorId={next} onClose={() => {}} />);
    await act(async () => { release(Response.json({ ...scheduleScope, schedule: grant, results: [] })); });
    expect(screen.queryByText(/Standing comparison: draft/)).toBeNull();
    expect(screen.queryByText(/"accountId": "123456789"/)).toBeNull();
  });
});
