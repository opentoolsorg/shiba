import { describe, expect, it, vi } from "vitest";
import { FounderReconciliationClient } from "./founder-reconciliation-client";
import { RECON_ACTOR, RECON_WORKSPACE, reconScope, reconciliationDraft } from "./founder-reconciliation-fixtures";
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
