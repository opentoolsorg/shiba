// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderReconciliation } from "./FounderReconciliation";
import { RECON_ACTOR, RECON_WORKSPACE, reconScope, reconciliationDraft, completedReconciliationCapture, rollingReconciliationFixture } from "../founder-reconciliation-fixtures";
import { hubspotGrant } from "../founder-hubspot-fixtures";
import { stripeGrant } from "../founder-stripe-fixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("private receipt comparison", () => {
  it("selects native captured receipts and requires separate mapping and comparison reviews", async () => {
    const d = reconciliationDraft(); d.expiresAt = Math.floor((Date.now() + 120000) / 60000) * 60000;
    const h = { ...hubspotGrant(), state: "exhausted" as const }, s = { ...stripeGrant(), id: d.sources.stripe.grantId, state: "exhausted" as const };
    const receipt = (id: string) => ({ id, state: "completed", createdAt: Date.now(), expiresAt: Date.now() + 600000 });
    const send = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const p = String(path);
      if (p === "/api/founder-hubspot-reads") return Response.json({ ...reconScope, available: true, grants: [h] });
      if (p === `/api/founder-hubspot-reads/${h.id}`) return Response.json({ ...reconScope, grant: h, receipts: [receipt(d.sources.hubspot.occurrenceId)] });
      if (p === "/api/founder-stripe-reads") return Response.json({ ...reconScope, available: true, grants: [s] });
      if (p === `/api/founder-stripe-reads/${s.id}`) return Response.json({ ...reconScope, grant: s, receipts: [receipt(d.sources.stripe.receiptId)] });
      if (p === "/api/founder-reconciliations" && init?.method === "POST") return Response.json({ ...reconScope, draft: d });
      if (p === "/api/founder-reconciliations") return Response.json({ ...reconScope, drafts: [] });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", send);
    render(<FounderReconciliation workspaceId={RECON_WORKSPACE} actorId={RECON_ACTOR} onClose={() => {}} />);
    expect(screen.getByText(/Invoice reconciliation is not MRR or churn/).textContent).toContain("defined customer or revenue cohort and period");
    fireEvent.change(await screen.findByLabelText("HubSpot portal grant"), { target: { value: h.id } });
    await screen.findByText(/Configured HubSpot fields/);
    fireEvent.change(screen.getByLabelText("Completed HubSpot occurrence"), { target: { value: d.sources.hubspot.occurrenceId } });
    fireEvent.change(screen.getByLabelText("Stripe invoice grant"), { target: { value: s.id } });
    const stripeOption = await screen.findByRole("option", { name: new RegExp(d.sources.stripe.receiptId) });
    expect(stripeOption).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Completed Stripe invoice receipt"), { target: { value: d.sources.stripe.receiptId } });
    fireEvent.change(screen.getByLabelText("CRM paid amount unit"), { target: { value: "major-decimal" } });
    const local = new Date(d.expiresAt - new Date(d.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText("Comparison expiry (local time)"), { target: { value: local } });
    const prepare = screen.getByRole("button", { name: "Prepare exact comparison review" });
    expect(prepare).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I attest the selected CRM field represents/));
    fireEvent.click(prepare);
    const compose = await screen.findByRole("button", { name: "Compose private comparison" });
    expect(compose).toHaveProperty("disabled", true);
    const body = JSON.parse(String(send.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    expect(body.hubspot).toEqual({ grantId: h.id, grantVersion: 1, occurrenceId: d.sources.hubspot.occurrenceId, sourceOrdinal: 0 });
    expect(send.mock.calls.some(([path]) => String(path).endsWith("/compose"))).toBe(false);
  });
  it("shows missing HubSpot source honestly, while permitting metadata revocation", async () => {
    const d = reconciliationDraft(); const send = vi.fn(async (path: RequestInfo | URL) => String(path) === "/api/founder-reconciliations" ? Response.json({ ...reconScope, drafts: [{ id: d.id, digest: d.digest, state: "draft", expiresAt: d.expiresAt }] }) : new Response("unavailable", { status: 503 })); vi.stubGlobal("fetch", send);
    render(<StrictMode><FounderReconciliation workspaceId={RECON_WORKSPACE} actorId={RECON_ACTOR} onClose={() => {}} /></StrictMode>);
    await screen.findByText(/eligible native HubSpot invoice snapshot is unavailable/); expect(screen.queryByText("Prepare an exact private comparison")).toBeNull(); expect(screen.getByRole("button", { name: `Revoke comparison ${d.id}` })).not.toHaveProperty("disabled", true);
  });
  it("requires an exact review before comparison and displays frozen source metadata", async () => {
    const d = reconciliationDraft(); const send = vi.fn(async (path: RequestInfo | URL) => String(path) === "/api/founder-reconciliations" ? Response.json({ ...reconScope, drafts: [{ id: d.id, digest: d.digest, state: "draft", expiresAt: d.expiresAt }] }) : String(path).endsWith(d.id) ? Response.json({ ...reconScope, draft: d, report: null }) : new Response("unavailable", { status: 503 })); vi.stubGlobal("fetch", send);
    render(<FounderReconciliation workspaceId={RECON_WORKSPACE} actorId={RECON_ACTOR} onClose={() => {}} />); fireEvent.click(await screen.findByRole("button", { name: "Review comparison" }));
    const compose = await screen.findByRole("button", { name: "Compose private comparison" }); expect(compose).toHaveProperty("disabled", true); expect(screen.getByText(/"accountId": "acct_fixture"/)).toBeTruthy(); fireEvent.click(screen.getByLabelText(/I reviewed the exact captured sources/)); expect(compose).toHaveProperty("disabled", false);
  });
  it("discards a stale actor response after switching scopes", async () => {
    let release!: (value: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; }); const next = "other@example.test"; let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => { if (String(path) !== "/api/founder-reconciliations") return new Response("unavailable", { status: 503 }); return ++requests === 1 ? held : Response.json({ ...reconScope, actorId: next, drafts: [] }); }));
    const view = render(<FounderReconciliation workspaceId={RECON_WORKSPACE} actorId={RECON_ACTOR} onClose={() => {}} />); view.rerender(<FounderReconciliation workspaceId={RECON_WORKSPACE} actorId={next} onClose={() => {}} />);
    await screen.findByText(/eligible native HubSpot invoice snapshot is unavailable/); await act(async () => { const d = reconciliationDraft(); release(Response.json({ ...reconScope, drafts: [{ id: d.id, digest: d.digest, state: "draft", expiresAt: d.expiresAt }] })); }); expect(screen.queryByRole("button", { name: "Review comparison" })).toBeNull();
  });
});

describe("reviewed rolling reconciliation UI", () => {
  async function openCompleted(options: { rejectRolling?: boolean; holdRolling?: Promise<Response> } = {}) {
    const capture = await completedReconciliationCapture();
    const send = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const p = String(path);
      if (p.endsWith("/rolling")) {
        if (options.holdRolling) return options.holdRolling;
        if (options.rejectRolling) return new Response("revoked", { status: 409 });
        const selection = JSON.parse(String(init?.body));
        return Response.json({ ...reconScope, report: rollingReconciliationFixture(capture, selection) });
      }
      if (p === "/api/founder-reconciliations") return Response.json({ ...reconScope, drafts: [capture.draft] });
      if (p.endsWith(capture.draft.id)) return Response.json({ ...reconScope, draft: capture.draft, report: capture.report });
      return new Response("unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", send);
    const view = render(<FounderReconciliation workspaceId={RECON_WORKSPACE} actorId={RECON_ACTOR} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review comparison" }));
    await screen.findByRole("region", { name: "Rolling-period reconciliation" });
    return { ...capture, send, view, calls: () => send.mock.calls.filter(([path]) => String(path).endsWith("/rolling")) };
  }
  const reviewRolling = () => fireEvent.click(screen.getByLabelText(/I reviewed this exact UTC period/));
  const submitRolling = () => fireEvent.click(screen.getByRole("button", { name: "Compose reviewed rolling report" }));
  it("shows period, source basis and mapping before an unchecked review; never auto-composes", async () => {
    const fixture = await openCompleted();
    expect(fixture.calls()).toHaveLength(0);
    expect(screen.getByLabelText(/I reviewed this exact UTC period/)).toHaveProperty("checked", false);
    expect(screen.getByRole("button", { name: "Compose reviewed rolling report" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Period basis: Stripe invoice created timestamp/)).toBeTruthy();
    expect(screen.getByText(/amount unit: major-decimal/)).toBeTruthy();
    reviewRolling(); submitRolling();
    const result = await screen.findByRole("region", { name: "Rolling report result" });
    expect(result.textContent).toContain("90071992547409930001");
    expect(result.textContent).toContain("stripe_capture_has_more_pages");
    expect(fixture.calls()).toHaveLength(1);
    expect(screen.getByLabelText(/I reviewed this exact UTC period/)).toHaveProperty("checked", false);
  });
  it("resets output and consent on metric, period and end changes; displays exact unavailable reasons", async () => {
    const fixture = await openCompleted();
    reviewRolling(); submitRolling(); await screen.findByRole("region", { name: "Rolling report result" });
    fireEvent.change(screen.getByLabelText("Metric definition"), { target: { value: "mrr" } });
    expect(screen.queryByRole("region", { name: "Rolling report result" })).toBeNull();
    expect(screen.getByLabelText(/I reviewed this exact UTC period/)).toHaveProperty("checked", false);
    reviewRolling(); submitRolling();
    const result = await screen.findByRole("region", { name: "Rolling report result" });
    expect(result.textContent).toContain("subscription_lifecycle_snapshots_not_captured");
    expect(result.querySelector("table")).toBeNull();
    fireEvent.change(screen.getByLabelText("Period length (days)"), { target: { value: "1" } });
    expect(screen.queryByRole("region", { name: "Rolling report result" })).toBeNull();
    reviewRolling();
    fireEvent.change(screen.getByLabelText("Period end (UTC, exclusive)"), { target: { value: new Date((fixture.asOf - 60) * 1000).toISOString().slice(0, 19) } });
    expect(screen.getByLabelText(/I reviewed this exact UTC period/)).toHaveProperty("checked", false);
    expect(fixture.calls()).toHaveLength(2);
  });
  it("clears private results and blocks retries when authority is revoked after proof", async () => {
    const fixture = await openCompleted({ rejectRolling: true });
    reviewRolling(); submitRolling();
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Rolling report result" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Rolling-period reconciliation" })).toBeNull();
    expect(screen.getByText(/uncertain action is not retried automatically/)).toBeTruthy();
    expect(fixture.calls()).toHaveLength(1);
  });
  it("discards a held rolling result after switching native actors", async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    const fixture = await openCompleted({ holdRolling: held });
    reviewRolling(); submitRolling();
    fixture.view.rerender(<FounderReconciliation workspaceId={RECON_WORKSPACE} actorId="other@example.test" onClose={() => {}} />);
    await act(async () => { release(Response.json({ ...reconScope, report: rollingReconciliationFixture(fixture) })); });
    expect(screen.queryByRole("region", { name: "Rolling report result" })).toBeNull();
    expect(screen.queryByText("90071992547409930001")).toBeNull();
    expect(fixture.calls()).toHaveLength(1);
  });
});
