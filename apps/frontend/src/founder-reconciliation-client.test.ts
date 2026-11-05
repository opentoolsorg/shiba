import { describe, expect, it, vi } from "vitest";
import { FounderReconciliationClient } from "./founder-reconciliation-client";
import { RECON_ACTOR, RECON_WORKSPACE, reconScope, reconciliationDraft, completedReconciliationCapture, rollingReconciliationFixture } from "./founder-reconciliation-fixtures";
const signal = () => new AbortController().signal;
const failure = async (p: Promise<unknown>) => { try { await p; return "unexpected success"; } catch (e) { return e instanceof Error ? e.message : String(e); } };
describe("native captured receipt reconciliation", () => {
  it("fences the account and never retries an unknown decision", async () => {
    const send = vi.fn(async () => Response.json({ ...reconScope, actorId: "other@example.test", drafts: [] }));
    const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, send); expect(await failure(client.list(signal()))).toContain("another native"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects changed source and mapping after review", async () => {
    const draft = reconciliationDraft(), changed = { ...draft, state: "completed", mapping: { ...draft.mapping, amountUnit: "minor-integer" } };
    const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, async () => Response.json({ ...reconScope, draft: changed, report: null }));
    expect(await failure(client.compose(draft, signal()))).toContain("not confirmed");
  });
  it("prevents use after source expiration and retains revoke access", async () => {
    const draft = reconciliationDraft(); draft.sources.hubspot.expiresAt = Date.now() - 1;
    const send = vi.fn(async () => Response.json({ ...reconScope, draft: { id: draft.id, digest: draft.digest, state: "revoked" } })); const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, send);
    expect(await failure(client.compose(draft, signal()))).toContain("expired"); expect(send).not.toHaveBeenCalled(); expect((await client.revoke(draft, signal())).draft.state).toBe("revoked"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("checks the exact report hash before returning data", async () => {
    const draft = reconciliationDraft(); const report = { format: "shiba.founder-reconciliation.report.v1", id: draft.id, executorDigest: draft.executorDigest, sources: draft.sources, mapping: draft.mapping, rows: [{ status: "matched_equal", dealId: "1", invoiceId: "in_fixture", stripeStatus: "paid", invoiceCreated: 42, currency: "USD", crmMinor: "100", stripeMinor: "100", differenceMinor: "0", reason: null }], perCurrency: [], notice: "bounded", datasetCompleteness: "unknown", businessSuccess: "unverified" };
    const bytes = new TextEncoder().encode(JSON.stringify([report.format, draft.id, draft.expiresAt, JSON.stringify(report)])); const reportHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
    const value = { ...reconScope, draft: { ...draft, state: "completed", reportHash }, report }, client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, async () => Response.json(value));
    expect((await client.detail(draft.id, signal())).report?.rows[0]).toMatchObject({ status: "matched_equal", stripeStatus: "paid", invoiceCreated: 42 }); value.report.notice = "changed"; expect(await failure(client.detail(draft.id, signal()))).toContain("digest");
  });
});

describe("reviewed rolling capture client", () => {
  it("posts exact consent and preserves integer strings above Number precision", async () => {
    const capture = await completedReconciliationCapture(), report = rollingReconciliationFixture(capture);
    const send = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json({ ...reconScope, report }));
    const result = await new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, send).rolling(capture.draft, { asOf: capture.asOf, periodDays: 7, metric: "invoice-paid-snapshot" }, signal());
    expect(result.perCurrency[0]?.stripeMinor).toBe("90071992547409930001");
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({ digest: capture.draft.digest, reviewed: true, consent: "filter-captured-invoice-created-window-not-revenue-mrr-or-churn", asOf: capture.asOf, periodDays: 7, metric: "invoice-paid-snapshot" });
  });
  it.each(["mrr", "churn"] as const)("returns %s unavailable, never relabeled invoice totals", async (metric) => {
    const capture = await completedReconciliationCapture(), selection = { asOf: capture.asOf, periodDays: 1, metric };
    const report = rollingReconciliationFixture(capture, selection);
    const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, async () => Response.json({ ...reconScope, report }));
    expect((await client.rolling(capture.draft, selection, signal())).metricAvailability.status).toBe("unavailable");
    report.perCurrency = capture.report.perCurrency;
    expect(await failure(client.rolling(capture.draft, selection, signal()))).toContain("availability");
  });
  it("refuses unreviewed, expired, future, and outside-window captures without any fetch", async () => {
    const capture = await completedReconciliationCapture(), send = vi.fn();
    const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, send), selection = { asOf: capture.asOf, periodDays: 7, metric: "invoice-paid-snapshot" as const };
    for (const draft of [{ ...capture.draft, state: "draft" as const }, { ...capture.draft, state: "revoked" as const }, { ...capture.draft, expiresAt: 1 }, { ...capture.draft, sources: { ...capture.draft.sources, stripe: { ...capture.draft.sources.stripe, capturedAt: Date.now() + 100000 } } }]) expect(await failure(client.rolling(draft, selection, signal()))).not.toBe("unexpected success");
    for (const change of [{ periodDays: 29 }, { periodDays: 1.5 }, { asOf: capture.asOf + 1 }, { asOf: capture.asOf - 28 * 86400 }]) expect(await failure(client.rolling(capture.draft, { ...selection, ...change }, signal()))).not.toBe("unexpected success");
    expect(send).not.toHaveBeenCalled();
  });
  it("fences tenant, actor, review digest, UTC boundaries and mapping responses", async () => {
    const capture = await completedReconciliationCapture(), selection = { asOf: capture.asOf, periodDays: 7, metric: "invoice-paid-snapshot" as const };
    const report = rollingReconciliationFixture(capture), original = { ...reconScope, report };
    for (const value of [
      { ...original, workspaceId: `ws_${"b".repeat(24)}` },
      { ...original, actorId: "other@example.test" },
      { ...original, report: { ...report, provenance: { ...report.provenance, reviewDigest: "b".repeat(64) } } },
      { ...original, report: { ...report, period: { ...report.period, createdLt: report.period.createdLt + 1 } } },
      { ...original, report: { ...report, period: { ...report.period, timezone: "America/New_York" } } },
      { ...original, report: { ...report, mapping: { ...report.mapping, amountUnit: "minor-integer" } } },
    ]) {
      const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, async () => Response.json(value));
      expect(await failure(client.rolling(capture.draft, selection, signal()))).not.toBe("unexpected success");
    }
  });
  it("does not retry a revocation or unknown outcome after proof", async () => {
    const capture = await completedReconciliationCapture();
    for (const respond of [() => new Response("revoked", { status: 409 }), () => { throw new Error("unknown outcome"); }]) {
      const send = vi.fn(async () => respond());
      const client = new FounderReconciliationClient(RECON_WORKSPACE, RECON_ACTOR, send);
      expect(await failure(client.rolling(capture.draft, { asOf: capture.asOf, periodDays: 7, metric: "invoice-paid-snapshot" }, signal()))).not.toBe("unexpected success");
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
