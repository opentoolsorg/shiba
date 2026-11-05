import { describe, expect, it, vi } from "vitest";
import { FounderAutomaticSlackClient } from "./founder-automatic-slack-client";
import { AUTO_SLACK_ACTOR, AUTO_SLACK_LIBRARY, AUTO_SLACK_WORKSPACE, automaticSlackGrant, automaticSlackState } from "./founder-automatic-slack-fixtures";
const signal = () => new AbortController().signal;
const failure = async (work: Promise<unknown>) => { try { await work; throw new Error("Expected rejection"); } catch (error) { return error instanceof Error ? error.message : String(error); } };
const client = (fetcher: typeof fetch, actor = AUTO_SLACK_ACTOR) => new FounderAutomaticSlackClient(AUTO_SLACK_WORKSPACE, AUTO_SLACK_LIBRARY, actor, fetcher);

describe("separate future Slack delivery client", () => {
  it("reads the production endpoint with scoped same-origin cookies and never posts on read", async () => {
    const state = automaticSlackState(), send = vi.fn(async () => Response.json(state));
    expect(await client(send).read(signal())).toEqual(state); expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([`/api/founder-skills/${AUTO_SLACK_LIBRARY}/automatic-slack`, expect.objectContaining({ method: "GET", credentials: "same-origin", redirect: "error", headers: expect.objectContaining({ "X-Shiba-Workspace": AUTO_SLACK_WORKSPACE }) })]);
  });
  it("rejects cross-account, unmanaged and substituted capability state", async () => {
    for (const mutate of [(value: ReturnType<typeof automaticSlackState>) => { value.actorId = "other@example.test"; }, (value: ReturnType<typeof automaticSlackState>) => { delete value.destinations[0]!.installation; }, (value: ReturnType<typeof automaticSlackState>) => { value.grants[0]!.canApprove = true; }]) {
      const state = automaticSlackState(); mutate(state); await expect(client(async () => Response.json(state)).read(signal())).rejects.toThrow();
    }
  });
  it("binds preview acknowledgment to exact sample, source version, destination and limits", async () => {
    const grant = automaticSlackGrant(), input = { requestId: crypto.randomUUID(), readGrantId: grant.readGrantId, readGrantVersion: grant.readGrantVersion, sampleOccurrenceId: grant.sampleOccurrenceId, sampleReportHash: grant.sampleReportHash, roomId: grant.destination.roomId, linkId: grant.destination.linkId, maxSends: grant.maxSends, expiresAt: grant.expiresAt };
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(automaticSlackState(grant))); await expect(client(send).prepare(input, signal())).resolves.toBeTruthy();
    expect(send.mock.calls[0]?.[0]).toContain("/preview");
    grant.maxSends++; expect(await failure(client(send).prepare(input, signal()))).toContain("differs");
    const before = send.mock.calls.length; expect(await failure(client(send).prepare({ ...input, expiresAt: Date.now() + 28 * 86_400_000 + 60_000 }, signal()))).toContain("28 days"); expect(send).toHaveBeenCalledTimes(before);
  });
  it("requires exact addressed disclosure acknowledgment and sends both explicit future consents", async () => {
    const grant = automaticSlackGrant(), next = automaticSlackState({ ...grant, state: "disclosed", canDisclose: false });
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(next));
    await client(send).decide(grant, "disclose", signal());
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({ expectedVersion: 1, digest: grant.digest, expiresAt: grant.expiresAt, reviewed: true, futureReportConsent: "share-future-completed-reports-from-this-exact-read-grant", audienceConsent: "all-current-and-future-people-with-access-to-selected-slack-channel-thread" });
    next.grants[0]!.digest = "d".repeat(64); expect(await failure(client(send).decide(grant, "disclose", signal()))).toContain("exact future-delivery decision");
  });
  it("validates UTF-8 delivery bytes and hash before returning private content", async () => {
    const state = automaticSlackState(), content = "Fictional evidence 🐕. Dataset completeness unknown; business success unverified.";
    const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))), (part) => part.toString(16).padStart(2, "0")).join("");
    state.deliveries = [{ id: "asd-fixture", grantId: state.grants[0]!.id, occurrenceId: "later-fixture", reportHash: "e".repeat(64), contentHash, content, state: "sent", createdAt: Date.now(), expiresAt: Date.now() + 600_000, receiptTs: "123.457", errorCode: null }];
    await expect(client(async () => Response.json(state)).read(signal())).resolves.toBeTruthy();
    state.deliveries[0]!.content += " changed"; expect(await failure(client(async () => Response.json(state)).read(signal()))).toContain("exact delivered report bytes");
  });
  it("never leaks raw upstream response details or retries denied requests", async () => {
    const send = vi.fn(async () => new Response("private-token-do-not-display", { status: 403 }));
    expect(await failure(client(send).read(signal()))).toContain("native identity"); expect(send).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort(); await expect(client(send).read(controller.signal)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("accepts an explicitly pinned weekly future family longer than the sample lease without silently extending old grants", async () => {
    const grant = automaticSlackGrant(); grant.readContract = { ...grant.readContract, cadence: "weekly", weekday: 1, expiresAt: Date.now() + 28 * 86_400_000 };
    grant.expiresAt = Date.now() + 21 * 86_400_000; grant.destination.installation!.expiresAt = null;
    const input = { requestId: crypto.randomUUID(), readGrantId: grant.readGrantId, readGrantVersion: grant.readGrantVersion, sampleOccurrenceId: grant.sampleOccurrenceId, sampleReportHash: grant.sampleReportHash, roomId: grant.destination.roomId, linkId: grant.destination.linkId, maxSends: grant.maxSends, expiresAt: grant.expiresAt };
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(automaticSlackState(grant)));
    await expect(client(send).prepare(input, signal())).resolves.toBeTruthy(); expect(grant.sampleExpiresAt).toBeLessThan(grant.expiresAt); expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(input);
    const old = automaticSlackGrant(), originalExpiry = old.expiresAt; await client(async () => Response.json(automaticSlackState(old))).read(signal()); expect(old.expiresAt).toBe(originalExpiry);
    grant.destination.installation!.expiresAt = Date.now() + 600_000; expect(await failure(client(send).read(signal()))).toContain("capabilities");
    grant.destination.installation!.expiresAt = null; grant.expiresAt = grant.readContract.expiresAt + 1; expect(await failure(client(send).read(signal()))).toContain("capabilities");
  });
});
