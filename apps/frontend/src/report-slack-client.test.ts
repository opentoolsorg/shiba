import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportSlackClient } from "./report-slack-client";
import type { ReportSlackState } from "@shiba/shared";

const WORKSPACE = "ws_" + "a".repeat(24), LIBRARY = "founder-stripe-revenue-pulse", REPORT = "report-fixture";
async function state(): Promise<ReportSlackState> {
  const content = "Stored app receipt excerpts. Completeness and business success are unverified.\n\nReviewed evidence.";
  const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const destination = { roomId: "room1", roomTitle: "Explicit room", linkId: "link1", teamId: "T1", channelId: "C1", threadTs: "1.1", ownerId: "owner@example.test", roomAudienceIds: ["owner@example.test"] };
  return { ok: true, workspaceId: WORKSPACE, libraryId: LIBRARY, reportId: REPORT, actorId: "owner@example.test", available: true, destinations: [destination], intents: [{
    id: "intent1", version: 1, digest: "b".repeat(64), reportHash: "a".repeat(64), sourceHash: "c".repeat(64), disclosureScope: "all-people-with-access-to-selected-slack-channel-thread",
    content, contentHash, creatorId: "owner@example.test", creatorAccountId: "native-uuid1", destination, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    status: "draft", disclosedAt: null, approvedByUserId: null, receiptTs: null, errorCode: null, canDisclose: true, canApprove: false, canCancel: true,
  }] };
}
afterEach(() => { vi.restoreAllMocks(); });
describe("one-shot report Slack HTTP client", () => {
  it("performs no automatic request and binds explicit disclosure to bytes, expiry and all channel readers", async () => {
    const value = await state(); let calls = 0;
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const result = structuredClone(value); if (calls++ > 0) { result.intents[0]!.status = "disclosed"; result.intents[0]!.canDisclose = false; }
      return Response.json(result);
    });
    const client = new ReportSlackClient(WORKSPACE, LIBRARY, REPORT, transport);
    expect(transport).not.toHaveBeenCalled(); await client.read(new AbortController().signal);
    const intent = value.intents[0]!; await client.disclose(intent, new AbortController().signal);
    const [url, init] = transport.mock.calls[1]!;
    expect(url).toBe(`/api/founder-skills/${LIBRARY}/reports/${REPORT}/slack/intents/intent1/disclose`);
    expect(init).toMatchObject({ credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(WORKSPACE);
    expect(JSON.parse(String(init?.body))).toEqual({ ...ReportSlackClient.decision(intent), disclosureConsent: "share-report-to-configured-slack-thread", audienceConsent: "all-people-with-access-to-selected-slack-channel-thread" });
  });
  it.each(["actor", "report", "hash", "capability"])("rejects a changed %s response without fallback or retries", async (which) => {
    const initial = await state(), changed = structuredClone(initial);
    if (which === "actor") changed.actorId = "other@example.test";
    if (which === "report") changed.reportId = "another-report";
    if (which === "hash") changed.intents[0]!.content += "changed";
    if (which === "capability") changed.intents[0]!.canApprove = true;
    let calls = 0; const client = new ReportSlackClient(WORKSPACE, LIBRARY, REPORT, async () => Response.json(calls++ === 0 ? initial : changed));
    await client.read(new AbortController().signal); await expect(client.read(new AbortController().signal)).rejects.toThrow(); expect(calls).toBe(2);
  });
  it("never sends after caller cancellation and never reflects a failed server body", async () => {
    const transport = vi.fn(async () => new Response("sensitive upstream error", { status: 403 })), client = new ReportSlackClient(WORKSPACE, LIBRARY, REPORT, transport);
    const controller = new AbortController(); controller.abort(); await expect(client.read(controller.signal)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
    await expect(client.read(new AbortController().signal)).rejects.toMatchObject({ message: expect.stringContaining("Current source ownership") }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not accept silent truncation or a substituted preparation destination", async () => {
    const value = await state(), client = new ReportSlackClient(WORKSPACE, LIBRARY, REPORT, async () => Response.json(value));
    await expect(client.prepare({ requestId: crypto.randomUUID(), reportHash: "a".repeat(64), roomId: "different", linkId: "link1", expiresAt: value.intents[0]!.expiresAt }, new AbortController().signal)).rejects.toMatchObject({ message: expect.stringContaining("selected report, destination and deadline") });
  });
  it.each(["missing", "other-id", "other-digest", "other-destination", "unclaimed"])("requires an exact addressed approval receipt: %s", async (which) => {
    const initial = await state(), expected = initial.intents[0]!, result = structuredClone(initial);
    result.intents[0]!.status = "sent"; result.intents[0]!.canDisclose = false; result.intents[0]!.canCancel = false;
    if (which === "missing") result.intents = [];
    if (which === "other-id") result.intents[0]!.id = "other-intent";
    if (which === "other-digest") result.intents[0]!.digest = "e".repeat(64);
    if (which === "other-destination") result.intents[0]!.destination.channelId = "OTHER";
    if (which === "unclaimed") { result.intents[0]!.status = "disclosed"; result.intents[0]!.canCancel = true; }
    const transport = vi.fn(async () => Response.json(result)), client = new ReportSlackClient(WORKSPACE, LIBRARY, REPORT, transport);
    await expect(client.approve(expected, new AbortController().signal)).rejects.toMatchObject({ message: expect.stringContaining("could not be confirmed") }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("preserves native fetch's global receiver and does not repeat an unknown send", async () => {
    const value = await state(), intent = value.intents[0]!; value.intents[0]!.status = "unknown"; value.intents[0]!.canDisclose = false; value.intents[0]!.canCancel = false;
    const original = globalThis.fetch, receivers: unknown[] = [];
    globalThis.fetch = async function (this: typeof globalThis) { receivers.push(this); return Response.json(value); };
    try { const client = new ReportSlackClient(WORKSPACE, LIBRARY, REPORT); await client.approve(intent, new AbortController().signal); expect(receivers).toEqual([globalThis]); }
    finally { globalThis.fetch = original; }
  });
});
