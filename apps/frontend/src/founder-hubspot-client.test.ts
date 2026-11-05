import { describe, expect, it, vi } from "vitest";
import { FounderHubSpotClient } from "./founder-hubspot-client";
import { HUBSPOT_ACTOR, HUBSPOT_WORKSPACE, hubspotGrant, hubspotScope } from "./founder-hubspot-fixtures";
const signal = () => new AbortController().signal;
const failure = async (work: Promise<unknown>) => { try { await work; return "unexpected success"; } catch (error) { return error instanceof Error ? error.message : String(error); } };
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(JSON.stringify(value))))), (n) => n.toString(16).padStart(2, "0")).join("");
describe("native HubSpot capture client", () => {
  it("binds the response to the native actor without retrying", async () => {
    const send = vi.fn(async () => Response.json({ ...hubspotScope, actorId: "outsider@example.test", available: true, grants: [] }));
    expect(await failure(new FounderHubSpotClient(HUBSPOT_WORKSPACE, HUBSPOT_ACTOR, send).list(signal()))).toContain("another workspace or native account");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("validates the exact capture, portal and projected property names before returning bytes", async () => {
    const grant = { ...hubspotGrant(), state: "exhausted" as const, currency: "USD", timezoneName: "UTC" };
    const receipt = { id: `fhr_${"c".repeat(32)}`, state: "completed" as const, createdAt: Date.now(), expiresAt: Date.now() + 60000 };
    const report = { format: "shiba.hubspot-read-report.v1", accountId: grant.accountId, grantId: grant.id, revision: grant.revision, contractDigest: grant.digest, executorDigest: grant.executorDigest, apiVersion: "crm-v3", currency: "USD", timezoneName: "UTC", capturedAt: Date.now(), capturedBytes: 100, notice: "Captured records only; completeness unknown.", capture: { records: [{ dealId: "1", properties: { invoice_id: "in_fixture", paid_amount: "10.00", currency: "USD" } }], selection: grant.selection, captureCompleteness: "bounded-response", datasetCompleteness: "unknown", businessSuccess: "unverified" } };
    const send = vi.fn(async function (this: unknown) { expect(this).toBe(globalThis); return Response.json({ ...hubspotScope, report, digest: await hash(report) }); });
    const client = new FounderHubSpotClient(HUBSPOT_WORKSPACE, HUBSPOT_ACTOR, send);
    expect((await client.report(grant, receipt, signal())).report.capture.records[0]?.dealId).toBe("1");
    report.capture.records[0]!.dealId = "999";
    expect(await failure(client.report(grant, receipt, signal()))).toContain("identity or digest");
    report.capture.records[0]!.dealId = "1"; report.accountId = "999";
    expect(await failure(client.report(grant, receipt, signal()))).toContain("identity or digest");
  });
  it("stops before fetching an expired capture", async () => {
    const send = vi.fn(), grant = { ...hubspotGrant(), state: "exhausted" as const };
    expect(await failure(new FounderHubSpotClient(HUBSPOT_WORKSPACE, HUBSPOT_ACTOR, send).report(grant, { id: `fhr_${"c".repeat(32)}`, state: "completed", createdAt: 1, expiresAt: Date.now() - 1 }, signal()))).toContain("expired");
    expect(send).not.toHaveBeenCalled();
  });
});
