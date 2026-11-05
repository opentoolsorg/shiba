// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderAutomaticSlack } from "./FounderAutomaticSlack";
import { FounderAutomaticSlackClient } from "../founder-automatic-slack-client";
import { AUTO_SLACK_ACTOR, AUTO_SLACK_LIBRARY, AUTO_SLACK_WORKSPACE, automaticSlackGrant, automaticSlackSample, automaticSlackState } from "../founder-automatic-slack-fixtures";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const client = (send: typeof fetch, actor = AUTO_SLACK_ACTOR) => new FounderAutomaticSlackClient(AUTO_SLACK_WORKSPACE, AUTO_SLACK_LIBRARY, actor, send);
const props = { workspaceId: AUTO_SLACK_WORKSPACE, libraryId: AUTO_SLACK_LIBRARY, actorId: AUTO_SLACK_ACTOR };

describe("explicit automatic founder Slack permission", () => {
  it("reads only on mount, starts blank and needs an exact current sample before prepare", async () => {
    const send = vi.fn(async () => Response.json(automaticSlackState())); render(<FounderAutomaticSlack {...props} client={client(send)} />);
    await screen.findByText(/Future delivery draft/); expect(send).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Maximum future sends") as HTMLInputElement).value).toBe(""); expect((screen.getByLabelText(/Future-delivery expiry/) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Prepare future-delivery draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Select and open a current completed/)).toBeTruthy(); expect(screen.queryByRole("link")).toBeNull();
  });
  it("requires separate source-owner future-audience consent, then never self-approves", async () => {
    const grant = automaticSlackGrant(), state = automaticSlackState(grant);
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { state.grants[0] = { ...grant, state: "disclosed", canDisclose: false }; } return Response.json(state);
    });
    render(<FounderAutomaticSlack {...props} sample={automaticSlackSample()} client={client(send)} />);
    const disclose = await screen.findByRole("button", { name: "Disclose this future report audience" }); expect(disclose.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/This is not the Slack member list/)).toBeTruthy(); expect(screen.getByText(/\[R1\] Fictional empty result/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I own every selected source/)); fireEvent.click(disclose);
    await screen.findByText(/Future delivery disclosed/); expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toMatchObject({ futureReportConsent: "share-future-completed-reports-from-this-exact-read-grant", audienceConsent: "all-current-and-future-people-with-access-to-selected-slack-channel-thread", digest: grant.digest });
    expect(screen.queryByRole("button", { name: "Approve bounded future reports" })).toBeNull();
  });
  it("requires the different human's exact review and does not retry an unknown approval acknowledgment", async () => {
    const actorId = "approver@example.test", grant = { ...automaticSlackGrant(), state: "disclosed" as const, canDisclose: false, canApprove: true, canRevoke: false };
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? new Response("unknown-private-details", { status: 502 }) : Response.json(automaticSlackState(grant, actorId)));
    render(<FounderAutomaticSlack {...props} actorId={actorId} client={client(send, actorId)} />);
    const approve = await screen.findByRole("button", { name: "Approve bounded future reports" }); expect(approve.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/As a separate configured human/)); fireEvent.click(approve);
    await screen.findByRole("alert"); expect(screen.queryByText(/\[R1\] Fictional empty result/)).toBeNull(); expect(screen.queryByText("unknown-private-details")).toBeNull(); expect(send).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh future Slack state" }));
    const returned = await screen.findByRole("button", { name: "Approve bounded future reports" }); expect(returned.hasAttribute("disabled")).toBe(true); expect(send).toHaveBeenCalledTimes(3);
  });
  it("clears denied source refresh and provides an actionable unavailable state without fallback", async () => {
    const state = automaticSlackState(); let deny = false; const send = vi.fn(async () => deny ? new Response("private", { status: 403 }) : Response.json(state));
    render(<FounderAutomaticSlack {...props} client={client(send)} />); await screen.findByText(/\[R1\] Fictional empty result/);
    deny = true; fireEvent.click(screen.getByRole("button", { name: "Refresh future Slack state" })); await screen.findByRole("alert"); expect(screen.queryByText(/\[R1\] Fictional empty result/)).toBeNull();
    cleanup(); state.available = false; render(<FounderAutomaticSlack {...props} client={client(async () => Response.json(state))} />);
    await screen.findByText(/Automatic delivery is unavailable/); expect(screen.queryByRole("button", { name: "Disclose this future report audience" })).toBeNull(); expect(screen.queryByText(/\[R1\] Fictional empty result/)).toBeNull();
  });
  it("hides private sample bytes and approval locally when their shorter lease expires", async () => {
    vi.useFakeTimers(); const grant = automaticSlackGrant(); grant.sampleExpiresAt = Date.now() + 1000;
    await act(async () => { render(<FounderAutomaticSlack {...props} client={client(async () => Response.json(automaticSlackState(grant)))} />); });
    expect(screen.getByText(/\[R1\] Fictional empty result/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); });
    expect(screen.queryByText(/\[R1\] Fictional empty result/)).toBeNull(); expect(screen.queryByRole("button", { name: "Disclose this future report audience" })).toBeNull();
  });
  it("ignores a held old actor response after switching native scope", async () => {
    let release!: (value: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; });
    const view = render(<FounderAutomaticSlack {...props} client={client(async () => held)} />);
    const actorId = "approver@example.test", state = automaticSlackState(null, actorId);
    view.rerender(<FounderAutomaticSlack {...props} actorId={actorId} client={client(async () => Response.json(state), actorId)} />);
    await screen.findByText(/Select and open a current completed/);
    await act(async () => { release(Response.json(automaticSlackState())); }); expect(screen.queryByText(/\[R1\] Fictional empty result/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Disclose this future report audience" })).toBeNull();
  });
  it("retains active weekly metadata and pause/revoke after illustrative sample expiry, with no expiry upgrade or automatic effect", async () => {
    vi.useFakeTimers(); const grant = automaticSlackGrant(); grant.state = "enabled"; grant.canDisclose = false; grant.canPause = true; grant.approvedByUserId = "approver@example.test"; grant.approvedAt = Date.now();
    grant.readContract = { ...grant.readContract, cadence: "weekly", weekday: 1, expiresAt: Date.now() + 28 * 86_400_000 }; grant.expiresAt = Date.now() + 21 * 86_400_000; grant.destination.installation!.expiresAt = null; grant.sampleExpiresAt = Date.now() + 1000;
    const originalExpiry = grant.expiresAt, send = vi.fn(async () => Response.json(automaticSlackState(grant)));
    await act(async () => { render(<FounderAutomaticSlack {...props} client={client(send)} />); }); expect(screen.getByText(/\[R1\] Fictional empty result/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); });
    expect(screen.queryByText(/\[R1\] Fictional empty result/)).toBeNull(); expect(screen.getByText(/Future delivery enabled/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause future delivery" })).not.toHaveProperty("disabled", true); expect(screen.getByRole("button", { name: "Revoke future delivery" })).not.toHaveProperty("disabled", true);
    expect(screen.getByTestId("automatic-slack-source-contract").textContent).toContain('"cadence": "weekly"'); expect(grant.expiresAt).toBe(originalExpiry); expect(send).toHaveBeenCalledTimes(1);
  });
});
