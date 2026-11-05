// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportSlackIntent, ReportSlackState } from "@shiba/shared";
import { REPORT_SLACK_DISCLOSURE_SCOPE } from "@shiba/shared";
import { ReportSlackDisclosure } from "./ReportSlackDisclosure";
import { ReportSlackClient } from "../report-slack-client";
import { EVIDENCE_WORKSPACE, EVIDENCE_LIBRARY, EVIDENCE_ACTOR } from "../founder-evidence-fixtures";
const props = { workspaceId: EVIDENCE_WORKSPACE, libraryId: EVIDENCE_LIBRARY, report: { id: "fer-fixture", reportHash: "b".repeat(64), expiresAt: Date.now() + 3_600_000 }, onClose: vi.fn() };
const base = `/api/founder-skills/${EVIDENCE_LIBRARY}/reports/fer-fixture/slack`;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const destination = { roomId: "room-one", roomTitle: "Authorized room", linkId: "link-one", teamId: "T_FIXTURE", channelId: "C_FIXTURE", threadTs: "123.456", ownerId: EVIDENCE_ACTOR, roomAudienceIds: [EVIDENCE_ACTOR] };
const intent = (): ReportSlackIntent => { const content = "Bounded stored excerpt. Completeness unknown. Business success unverified. PRIVATE-A"; return { id: "rsi-one", version: 1, digest: "a".repeat(64), reportHash: props.report.reportHash, sourceHash: "c".repeat(64), disclosureScope: REPORT_SLACK_DISCLOSURE_SCOPE,
  content, contentHash: createHash("sha256").update(content).digest("hex"), creatorId: EVIDENCE_ACTOR, creatorAccountId: "native-owner", destination, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
  status: "draft", disclosedAt: null, approvedByUserId: null, receiptTs: null, errorCode: null, canDisclose: true, canApprove: false, canCancel: true }; };
const state = (intents: ReportSlackIntent[] = []): ReportSlackState => ({ ok: true, workspaceId: EVIDENCE_WORKSPACE, libraryId: EVIDENCE_LIBRARY, reportId: "fer-fixture", actorId: EVIDENCE_ACTOR, available: true, destinations: [destination], intents });
const localExpiry = () => { const at = new Date(Date.now() + 600_000); return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

describe("separate manual report disclosure to Slack", () => {
  it("shows the exact managed installation generation when one is frozen into the destination", async () => {
    const current = intent(); current.destination = { ...destination, installation: { id: "install-one", workspaceId: EVIDENCE_WORKSPACE, ownerId: EVIDENCE_ACTOR, ownerAccountId: "native-owner", ownerMembershipVersion: 1, appId: "A_FIXTURE", teamId: destination.teamId, enterpriseId: null, botUserId: "U_BOT", botId: "B_BOT", installerSlackUserId: "U_OWNER", generation: 4, version: 3, tokenRevision: 2, scopes: ["chat:write"], expiresAt: null } };
    const fetcher = vi.fn(async () => Response.json(state([current]))); vi.stubGlobal("fetch", fetcher);
    render(<ReportSlackDisclosure {...props} />);
    await screen.findByText("Managed Slack installation: app A_FIXTURE · team T_FIXTURE · installation install-one · generation 4 · version 3.");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("requires private draft, wider-audience disclosure and a second exact review before one send", async () => {
    let held: ReportSlackIntent | null = null; const writes: Array<{ path: string; body: Record<string, unknown> }> = [], effects = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ path, body });
        if (path.endsWith("/preview")) held = { ...intent(), expiresAt: Number(body.expiresAt) };
        if (path.endsWith("/disclose")) held = { ...held!, status: "disclosed", disclosedAt: Date.now(), canDisclose: false, canApprove: true };
        if (path.endsWith("/approve")) { effects(); held = { ...held!, status: "sent", canApprove: false, canCancel: false, approvedByUserId: EVIDENCE_ACTOR, receiptTs: "123.999" }; }
      }
      return Response.json(state(held ? [held] : []));
    }));
    render(<ReportSlackDisclosure {...props} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Configured Slack destination" }), { target: { value: "link-one" } });
    fireEvent.change(screen.getByLabelText(/Disclosure draft expiry/), { target: { value: localExpiry() } });
    expect(writes).toEqual([]); expect(effects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare private Slack disclosure draft" }));
    const disclose = await screen.findByRole("button", { name: "Disclose this exact report audience" });
    expect((disclose as HTMLButtonElement).disabled).toBe(true); expect(effects).not.toHaveBeenCalled();
    expect(screen.getByText(/This is not the Slack member list/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I own all selected source connections/ }));
    fireEvent.click(disclose);
    const send = await screen.findByRole("button", { name: "Approve and send this complete small report once" });
    expect((send as HTMLButtonElement).disabled).toBe(true); expect(effects).not.toHaveBeenCalled();
    expect(writes[1]?.body).toMatchObject({ disclosureConsent: "share-report-to-configured-slack-thread", audienceConsent: REPORT_SLACK_DISCLOSURE_SCOPE, expectedVersion: 1, reviewed: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the complete message/ }));
    fireEvent.click(send); fireEvent.click(send);
    await screen.findByText("Delivery: sent");
    expect(effects).toHaveBeenCalledOnce(); expect(writes.map((item) => item.path)).toEqual([`${base}/preview`, `${base}/intents/rsi-one/disclose`, `${base}/intents/rsi-one/approve`]);
  });
  it("never retries an uncertain send even if refresh returns an older disclosed state", async () => {
    const held = { ...intent(), status: "disclosed" as const, canDisclose: false, canApprove: true, disclosedAt: Date.now() }, writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { writes.push(String(input)); throw new TypeError("Response lost"); }
      return Response.json(state([held]));
    }));
    render(<ReportSlackDisclosure {...props} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /I reviewed the complete message/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and send this complete small report once" }));
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Refresh Slack disclosure state" }));
    const send = await screen.findByRole("button", { name: "Approve and send this complete small report once" });
    expect((send as HTMLButtonElement).disabled).toBe(true); fireEvent.click(send); expect(writes).toHaveLength(1);
  });
  it("hides draft content when current source ownership or room permission is revoked", async () => {
    let revoked = false;
    vi.stubGlobal("fetch", vi.fn(async () => revoked ? Response.json({ error: "source_revoked" }, { status: 403 }) : Response.json(state([intent()]))));
    render(<ReportSlackDisclosure {...props} />); await screen.findByText(/PRIVATE-A/);
    revoked = true; fireEvent(window, new Event("focus")); await screen.findByRole("alert");
    expect(screen.queryByText(/PRIVATE-A/)).toBeNull(); expect(screen.queryByRole("button", { name: "Disclose this exact report audience" })).toBeNull();
  });
  it("rejects a late private draft after switching to another report/workspace", async () => {
    let finish!: (response: Response) => void; const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const foreign = `ws_${"b".repeat(24)}`;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Headers(init?.headers).get("X-Shiba-Workspace") === foreign
      ? Response.json({ ...state(), workspaceId: foreign, reportId: "fer-other", available: false, destinations: [] }) : pending));
    const { rerender } = render(<ReportSlackDisclosure {...props} />);
    rerender(<ReportSlackDisclosure {...props} workspaceId={foreign} report={{ ...props.report, id: "fer-other" }} />);
    await screen.findByText(/Slack disclosure is unavailable/);
    await act(async () => finish(Response.json(state([intent()])))); expect(screen.queryByText(/PRIVATE-A/)).toBeNull();
  });
  it("hides private draft content at local report expiry without waiting for a poll", async () => {
    vi.useFakeTimers(); const before = Date.now(), fetcher = vi.fn(async () => Response.json(state([intent()]))); vi.stubGlobal("fetch", fetcher);
    const actualRead = ReportSlackClient.prototype.read;
    let completed!: () => void, failed!: (cause: unknown) => void;
    const verifiedRead = new Promise<void>((resolve, reject) => { completed = resolve; failed = reject; });
    vi.spyOn(ReportSlackClient.prototype, "read").mockImplementation(async function (this: ReportSlackClient, signal) {
      try { const value = await actualRead.call(this, signal); completed(); return value; }
      catch (cause) { failed(cause); throw cause; }
    });
    // Await the real body parsing and WebCrypto verification while fake time is fixed.
    render(<ReportSlackDisclosure {...props} report={{ ...props.report, expiresAt: before + 100 }} />);
    await act(async () => { await verifiedRead; });
    expect(Date.now()).toBe(before); expect(screen.getByText(/PRIVATE-A/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(99); }); expect(screen.getByText(/PRIVATE-A/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(screen.queryByText(/PRIVATE-A/)).toBeNull(); expect(screen.queryByRole("button", { name: "Disclose this exact report audience" })).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
