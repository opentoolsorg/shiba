import { describe, expect, it, vi } from "vitest";
import { FounderMetaClient } from "./founder-meta-client";
import { META_ACTOR, META_WORKSPACE, metaGrant, metaScope } from "./founder-meta-fixtures";
const signal = () => new AbortController().signal;
const failure = async (p: Promise<unknown>) => { try { await p; return "unexpected success"; } catch (e) { return e instanceof Error ? e.message : String(e); } };
describe("native Meta client", () => {
  it("rejects a foreign account scope and never retries unknown provider outcomes", async () => {
    const send = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json({ ...metaScope, actorId: "other@example.test", available: true, grants: [] }));
    const client = new FounderMetaClient(META_WORKSPACE, META_ACTOR, send); expect(await failure(client.list(signal()))).toContain("another workspace or native account"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("accepts verified account only with new digest, currency, timezone and one call", async () => {
    const grant = metaGrant(); let next = { ...grant, state: "verified" as const, digest: "a".repeat(64), currency: "USD", timezoneName: "America/New_York", usedCalls: 1 };
    const send = vi.fn(async () => Response.json({ ...metaScope, grant: next })), client = new FounderMetaClient(META_WORKSPACE, META_ACTOR, send);
    expect((await client.decide(grant, "verify", signal())).currency).toBe("USD"); next = { ...next, digest: grant.digest }; expect(await failure(client.decide(grant, "verify", signal()))).toContain("not confirmed");
  });
  it("checks report hash, exact selection, currency and expiry", async () => {
    const grant = { ...metaGrant(), state: "enabled" as const, currency: "USD", timezoneName: "UTC" }, receipt = { id: `fmr_${"e".repeat(32)}`, state: "completed" as const, createdAt: Date.now(), expiresAt: Date.now() + 10000 };
    const report = { format: "shiba.meta-read-report.v1", accountId: grant.accountId, grantId: grant.id, revision: grant.revision, contractDigest: grant.digest, executorDigest: grant.executorDigest, apiVersion: "v25.0", capturedAt: Date.now(), capturedBytes: 100, notice: "bounded", capture: { rows: [{ impressions: "42", clicks: "5", spend: "1.24", accountCurrency: "USD", dateStart: grant.selection.since, dateStop: grant.selection.until }], selection: grant.selection, captureCompleteness: "bounded-response", datasetCompleteness: "unknown", businessSuccess: "unverified" } };
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(JSON.stringify(report))))), (n) => n.toString(16).padStart(2, "0")).join("");
    const value = { ...metaScope, report, digest }, client = new FounderMetaClient(META_WORKSPACE, META_ACTOR, async () => Response.json(value)); expect((await client.report(grant, receipt, signal())).digest).toBe(digest);
    value.report.capture.rows[0]!.spend = "2.00"; expect(await failure(client.report(grant, receipt, signal()))).toContain("digest");
  });
  it("aborts a stalled body and rejects oversized data", async () => {
    const controller = new AbortController(), stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const client = new FounderMetaClient(META_WORKSPACE, META_ACTOR, async () => new Response(stream)), result = failure(client.list(controller.signal)); controller.abort(); expect(await result).not.toBe("unexpected success");
    expect(await failure(new FounderMetaClient(META_WORKSPACE, META_ACTOR, async () => new Response("x".repeat(1048577))).list(signal()))).toContain("review bound");
  });
});
