import { describe, expect, it, vi } from "vitest";
import { FounderStripeClient } from "./founder-stripe-client";
import { STRIPE_ACTOR, STRIPE_WORKSPACE, stripeGrant, stripeScope } from "./founder-stripe-fixtures";
const signal = () => new AbortController().signal;
const failure = async (work: Promise<unknown>) => { try { await work; return "unexpected success"; } catch (error) { return error instanceof Error ? error.message : String(error); } };
describe("native private Stripe client", () => {
  it("enforces workspace, actor and grant scope before returning data", async () => {
    const send = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json({ ...stripeScope, actorId: "other@example.test", available: true, grants: [] }));
    const client = new FounderStripeClient(STRIPE_WORKSPACE, STRIPE_ACTOR, send);
    expect(await failure(client.list(signal()))).toContain("another workspace or native account");
    expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Shiba-Workspace": STRIPE_WORKSPACE });
  });
  it("does not retry an uncertain mutation or expose the response body", async () => {
    const send = vi.fn(async () => new Response("private provider details", { status: 503 }));
    const client = new FounderStripeClient(STRIPE_WORKSPACE, STRIPE_ACTOR, send);
    expect(await failure(client.decide(stripeGrant(), "verify", signal()))).toContain("unavailable or disabled");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects a decision whose exact grant changed", async () => {
    const grant = stripeGrant(), send = vi.fn(async () => Response.json({ ...stripeScope, grant: { ...grant, state: "verified", accountId: "acct_other" } }));
    expect(await failure(new FounderStripeClient(STRIPE_WORKSPACE, STRIPE_ACTOR, send).decide(grant, "verify", signal()))).toContain("not confirmed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized bounded responses and aborted requests", async () => {
    const send = vi.fn(async () => new Response("x".repeat(1_048_577)));
    const client = new FounderStripeClient(STRIPE_WORKSPACE, STRIPE_ACTOR, send);
    expect(await failure(client.list(signal()))).toContain("review bound");
    const controller = new AbortController(); controller.abort(); expect(await failure(client.list(controller.signal))).not.toBe("unexpected success"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("stops waiting on a stalled response body when its scope is aborted", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const client = new FounderStripeClient(STRIPE_WORKSPACE, STRIPE_ACTOR, async () => new Response(stream));
    const controller = new AbortController(), pending = failure(client.list(controller.signal)); controller.abort();
    expect(await pending).not.toBe("unexpected success");
  });
  it("checks the report digest and its exact grant before exposing a capture", async () => {
    const grant = { ...stripeGrant(), state: "enabled" as const }, receipt = { id: `fsr_${"e".repeat(32)}`, state: "completed" as const, createdAt: Date.now(), expiresAt: Date.now() + 10000 };
    const report = { format: "shiba.stripe-read-report.v1", accountId: grant.accountId, mode: grant.mode, grantId: grant.id, revision: grant.revision, contractDigest: grant.digest, apiVersion: grant.apiVersion, capturedAt: Date.now(), capture: { rows: [] as string[] }, summary: null };
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(JSON.stringify(report))))), (n) => n.toString(16).padStart(2, "0")).join("");
    const value = { ...stripeScope, report, digest: hash }, client = new FounderStripeClient(STRIPE_WORKSPACE, STRIPE_ACTOR, async () => Response.json(value));
    expect((await client.report(grant, receipt, signal())).digest).toBe(hash);
    value.report.capture = { rows: ["altered"] }; expect(await failure(client.report(grant, receipt, signal()))).toContain("digest");
  });
});
