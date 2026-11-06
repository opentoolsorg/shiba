import { describe, expect, it, vi } from "vitest";
import { FounderReconciliationSchedulesClient, type ReconciliationScheduledResult } from "./founder-reconciliation-schedules-client";
import { SCHEDULE_ACTOR, SCHEDULE_WORKSPACE, scheduleScope, standingComparison } from "./founder-reconciliation-schedules-fixtures";
const signal = () => new AbortController().signal;
const failure = async (work: Promise<unknown>) => { try { await work; return "unexpected success"; } catch (error) { return error instanceof Error ? error.message : String(error); } };
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (n) => n.toString(16).padStart(2, "0")).join("");
describe("future private comparison client", () => {
  it("rejects a foreign native actor without retrying", async () => {
    const send = vi.fn(async () => Response.json({ ...scheduleScope, actorId: "outsider@example.test", available: true, schedules: [] }));
    expect(await failure(new FounderReconciliationSchedulesClient(SCHEDULE_WORKSPACE, SCHEDULE_ACTOR, send).list(signal()))).toContain("another native"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("permits a standing lease beyond the sample receipt lease but freezes both grant contracts", async () => {
    const s = standingComparison(); let changed = false;
    const send = vi.fn(async () => Response.json({ ...scheduleScope, schedule: changed ? { ...s, state: "enabled", cutoffAt: Date.now(), sourceGrants: { ...s.sourceGrants, hubspot: { ...s.sourceGrants.hubspot, digest: "0".repeat(64) } } } : s }));
    const client = new FounderReconciliationSchedulesClient(SCHEDULE_WORKSPACE, SCHEDULE_ACTOR, send);
    expect((await client.prepare({ comparisonId: s.sampleId, expiresAt: s.expiresAt, maxComparisons: s.maxComparisons, maxSkewMinutes: s.maxSkewMinutes }, signal())).expiresAt).toBeGreaterThan(s.sampleSources.hubspot.expiresAt);
    changed = true; expect(await failure(client.enable(s, signal()))).toContain("not confirmed"); expect(send).toHaveBeenCalledTimes(2);
  });
  it("retains revocation access after the standing lease expires", async () => {
    const s = standingComparison(); s.expiresAt = Date.now() - 1;
    const send = vi.fn(async () => Response.json({ ...scheduleScope, schedule: { id: s.id, digest: s.digest, state: "revoked" } }));
    const client = new FounderReconciliationSchedulesClient(SCHEDULE_WORKSPACE, SCHEDULE_ACTOR, send);
    expect(await failure(client.enable(s, signal()))).toContain("expired"); expect(send).not.toHaveBeenCalled();
    expect((await client.reduce(s, "revoke", signal())).state).toBe("revoked"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("verifies future report identity, original source scope, skew and hash", async () => {
    const s = { ...standingComparison(), state: "enabled" as const, cutoffAt: Date.now() - 30000 };
    const id = `frr_${"1".repeat(32)}`, expiresAt = Date.now() + 60000;
    const report = { format: "shiba.founder-reconciliation.scheduled-report.v1", id, scheduleId: s.id, scheduleDigest: s.digest, sourceGrants: s.sourceGrants, principal: { kind: "schedule", id: `schedule:${s.id}` }, authorization: "standing-future-comparison-consent", mapping: s.mapping, sources: structuredClone(s.sampleSources), rows: [], perCurrency: [], notice: "Captured rows only.", datasetCompleteness: "unknown", businessSuccess: "unverified" };
    report.sources.hubspot.occurrenceId = `fhr_${"2".repeat(32)}`; report.sources.stripe.receiptId = `fsr_${"4".repeat(32)}`;
    report.sources.hubspot.capturedAt = Date.now() - 2000; report.sources.stripe.capturedAt = Date.now() - 1000;
    const receipt: ReconciliationScheduledResult = { id, scheduleId: s.id, state: "completed", createdAt: Date.now(), expiresAt, reportHash: null };
    let actual = await digest([report.format, id, expiresAt, JSON.stringify(report)]); receipt.reportHash = actual;
    const send = vi.fn(async function (this: unknown) { expect(this).toBe(globalThis); return Response.json({ ...scheduleScope, report, digest: actual }); });
    const client = new FounderReconciliationSchedulesClient(SCHEDULE_WORKSPACE, SCHEDULE_ACTOR, send);
    expect((await client.report(s, receipt, signal())).report.authorization).toBe("standing-future-comparison-consent");
    report.sources.hubspot.accountId = "999"; actual = await digest([report.format, id, expiresAt, JSON.stringify(report)]); receipt.reportHash = actual;
    expect(await failure(client.report(s, receipt, signal()))).toContain("source, consent, lease or digest");
  });
});
