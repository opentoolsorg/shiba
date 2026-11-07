// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderReconciliationAutomaticSlack } from "./FounderReconciliationAutomaticSlack";
import { FounderReconciliationSlackClient } from "../founder-reconciliation-slack-client";
import { SLACK_RECON_OWNER, SLACK_RECON_MANAGER, SLACK_RECON_WORKSPACE, reconciliationSlackFixture } from "../founder-reconciliation-slack-fixtures";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const scoped = (actorId: string, grant: unknown) => ({ workspaceId: SLACK_RECON_WORKSPACE, actorId, grant });
describe("future combined report Slack review", () => {
  it("requires owner disclosure of exact sample and broad future audience", async () => {
    const { grant, destination } = reconciliationSlackFixture(); const metadata = { id: grant.id, digest: grant.digest, state: grant.state, expiresAt: grant.expiresAt };
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? Response.json(scoped(SLACK_RECON_OWNER, { ...grant, state: "disclosed" })) : String(path).endsWith(grant.id) ? Response.json(scoped(SLACK_RECON_OWNER, grant)) : Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: true, destinations: [destination], grants: [metadata] }));
    const client = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, fetcher); render(<StrictMode><FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_OWNER} client={client} /></StrictMode>);
    fireEvent.click(await screen.findByRole("button", { name: "Open exact delivery grant" })); expect(await screen.findByText(/Qualified captured rows/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Disclose future combined evidence" }); expect(button).toHaveProperty("disabled", true); fireEvent.click(screen.getByLabelText(/I own this exact source schedule/)); fireEvent.click(button); await screen.findByText("Combined future delivery: disclosed");
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST"); expect(writes).toHaveLength(1); expect(JSON.parse(String(writes[0]![1]?.body))).toMatchObject({ futureReportConsent: "share-future-combined-reconciliation-results-from-this-exact-schedule", audienceConsent: "all-current-and-future-people-with-access-to-selected-slack-channel-thread" });
  });
  it("requires a different manager to review before approval", async () => {
    const fixture = reconciliationSlackFixture(), grant = { ...fixture.grant, state: "disclosed" as const };
    const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path).endsWith(grant.id) ? Response.json(scoped(SLACK_RECON_MANAGER, grant)) : Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_MANAGER, available: true, destinations: [], grants: [{ id: grant.id, digest: grant.digest, state: grant.state, expiresAt: grant.expiresAt }] }));
    render(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_MANAGER} client={new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_MANAGER, fetcher)} />); fireEvent.click(await screen.findByRole("button", { name: "Open exact delivery grant" }));
    const approve = await screen.findByRole("button", { name: "Approve future combined evidence" }); expect(approve).toHaveProperty("disabled", true); fireEvent.click(screen.getByLabelText(/As a different configured native manager/)); expect(approve).toHaveProperty("disabled", false); expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/approve"))).toHaveLength(0);
  });
  it("retains reduction controls without full source or enabled feature", async () => {
    const { grant } = reconciliationSlackFixture(); const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? Response.json(scoped(SLACK_RECON_OWNER, { id: grant.id, digest: grant.digest, state: "revoked" })) : Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: false, destinations: [], grants: [{ id: grant.id, digest: grant.digest, state: "enabled", expiresAt: grant.expiresAt }] }));
    render(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_OWNER} client={new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: `Revoke delivery ${grant.id}` })); await screen.findByText(new RegExp(`${grant.id} · revoked`)); expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("clears a sample at its shorter source lease", async () => {
    vi.useFakeTimers(); const { grant } = reconciliationSlackFixture(); grant.schedule.sourceGrants.stripe.expiresAt = Date.now() + 1000;
    const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path).endsWith(grant.id) ? Response.json(scoped(SLACK_RECON_OWNER, grant)) : Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: true, destinations: [], grants: [{ id: grant.id, digest: grant.digest, state: grant.state, expiresAt: grant.expiresAt }] }));
    await act(async () => { render(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_OWNER} client={new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, fetcher)} />); }); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open exact delivery grant" })); }); expect(screen.getByText(/Qualified captured rows/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); }); expect(screen.queryByText(/Qualified captured rows/)).toBeNull();
  });
  it("discards a late private grant after hiding the tab", async () => {
    const { grant } = reconciliationSlackFixture(); let release!: (response: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path).endsWith(grant.id) ? held : Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: true, destinations: [], grants: [{ id: grant.id, digest: grant.digest, state: grant.state, expiresAt: grant.expiresAt }] }));
    render(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_OWNER} client={new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, fetcher)} />); fireEvent.click(await screen.findByRole("button", { name: "Open exact delivery grant" }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { release(Response.json(scoped(SLACK_RECON_OWNER, grant))); }); expect(screen.queryByText(/Qualified captured rows/)).toBeNull(); expect(screen.getByText(/Refresh and inspect the current grant/)).toBeTruthy(); visibility.mockRestore();
  });
  it("drops a late response after changing the native actor", async () => {
    const { grant } = reconciliationSlackFixture(); let release!: (response: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; });
    const first = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, async () => held), second = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_MANAGER, async () => Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_MANAGER, available: true, destinations: [], grants: [] }));
    const view = render(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_OWNER} client={first} />); view.rerender(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_MANAGER} client={second} />);
    await screen.findByRole("button", { name: "Refresh combined Slack access" }); await act(async () => { release(Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: true, destinations: [], grants: [{ id: grant.id, digest: grant.digest, state: grant.state, expiresAt: grant.expiresAt }] })); }); expect(screen.queryByText(new RegExp(grant.id))).toBeNull();
  });
  it("requires refresh after an unknown prepare and preserves the exact request ID", async () => {
    const { destination, sample } = reconciliationSlackFixture(); const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? new Response("unconfirmed", { status: 503 }) : Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: true, destinations: [destination], grants: [] }));
    render(<FounderReconciliationAutomaticSlack workspaceId={SLACK_RECON_WORKSPACE} actorId={SLACK_RECON_OWNER} sample={sample} client={new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, fetcher)} />);
    fireEvent.change(await screen.findByLabelText("Exact Slack destination"), { target: { value: destination.linkId } }); fireEvent.change(screen.getByLabelText("Maximum future sends"), { target: { value: "2" } });
    const expiresAt = new Date(Date.now() + 1800000);
    // datetime-local accepts wall-clock time, not the UTC value from toISOString().
    const localExpiry = new Date(expiresAt.getTime() - expiresAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText("Delivery expiry (local time)"), { target: { value: localExpiry } }); const prepare = screen.getByRole("button", { name: "Prepare combined Slack disclosure" }); fireEvent.click(prepare);
    expect((await screen.findByRole("alert")).textContent).toContain("Outcome not confirmed."); expect(prepare.closest("fieldset")).toHaveProperty("disabled", true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1); fireEvent.click(prepare); expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh combined Slack access" })); await waitFor(() => expect(prepare.closest("fieldset")).toHaveProperty("disabled", false)); fireEvent.click(prepare); expect((await screen.findByRole("alert")).textContent).toContain("Outcome not confirmed.");
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST"); expect(writes).toHaveLength(2); const first = JSON.parse(String(writes[0]![1]?.body)); expect(first.expiresAt).toBe(Math.floor(expiresAt.getTime() / 60000) * 60000); expect(JSON.parse(String(writes[1]![1]?.body))).toEqual(first); expect(first.requestId).toBe(JSON.parse(String(writes[1]![1]?.body)).requestId);
  });
});
