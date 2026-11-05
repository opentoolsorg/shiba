import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { founderAutomaticReadReportHash } from "@shiba/shared";
import { FounderAutomaticClient } from "./founder-automatic-client";
import { AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, AUTOMATIC_BASE, automaticInput, automaticOptions, automaticGrant, automaticState, automaticOccurrence, automaticReport } from "./founder-automatic-fixtures";
const signal = () => new AbortController().signal;
const failure = async (work: Promise<unknown>) => { try { await work; throw new Error("Expected rejection"); } catch (error) { return error instanceof Error ? error.message : String(error); } };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("separate scheduled-read client authority", () => {
  it("uses scoped read-only endpoints and the native fetch receiver without choosing any source", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", function (this: unknown, input: RequestInfo | URL, init?: RequestInit) { expect(this).toBe(globalThis); calls.push({ path: String(input), init }); return Promise.resolve(Response.json(String(input).endsWith("/options") ? automaticOptions() : automaticState())); });
    const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY); expect(calls).toEqual([]);
    await client.state(signal()); await client.options(signal()); expect(calls.map((item) => item.path)).toEqual([AUTOMATIC_BASE, `${AUTOMATIC_BASE}/options`]);
    for (const call of calls) { expect(call.init?.method).toBe("GET"); expect(new Headers(call.init?.headers).get("X-Shiba-Workspace")).toBe(AUTOMATIC_WORKSPACE); expect(call.init?.credentials).toBe("same-origin"); expect(call.init?.redirect).toBe("error"); }
  });
  it("pins the native actor and rejects foreign scope, account directories and principals", async () => {
    let next: unknown = automaticState(); const fetcher = vi.fn(async () => Response.json(next)); const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, fetcher);
    await client.state(signal()); next = { ...automaticState(), actorId: "other@example.test" }; expect(await failure(client.state(signal()))).toContain("another native account");
    next = { ...automaticState(), workspaceId: `ws_${"b".repeat(24)}` }; expect(await failure(client.state(signal()))).toContain("another native account");
    next = { ...automaticOptions(), connections: automaticOptions().connections.map((item) => ({ ...item, workspaceId: `ws_${"b".repeat(24)}` })) }; expect(await failure(client.options(signal()))).toContain("directory");
    const grant = automaticGrant(); grant.contract.ownerId = "other@example.test"; next = automaticState(grant); expect(await failure(client.state(signal()))).toContain("another owner");
  });
  it("saves a draft only for the exact ordered arguments and bounds, never automatically enabling", async () => {
    const input = automaticInput(), grant = automaticGrant(input), writes: Array<{ path: string; body: unknown }> = [];
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => { writes.push({ path: String(path), body: JSON.parse(String(init?.body)) }); return Response.json(automaticState(grant)); });
    const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, fetcher); await client.configure(input, signal());
    expect(writes).toEqual([{ path: AUTOMATIC_BASE, body: input }]);
    grant.contract.operations[0]!.arguments = { owner: "another", repo: "fixture", perPage: 5, state: "open" };
    expect(await failure(client.configure(input, signal()))).toContain("does not match"); expect(writes).toHaveLength(2);
  });
  it("adds standing-read and quota consent only to explicit enable or resume, and verifies exact acknowledgments", async () => {
    const grant = automaticGrant(), calls: Array<Record<string, unknown>> = []; let action = "enable";
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return Response.json(automaticState({ ...grant, version: grant.version + 1, state: action === "pause" ? "paused" : "enabled" })); });
    const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, fetcher);
    await client.decide(grant, "enable", signal()); expect(calls[0]).toMatchObject({ expectedVersion: 1, digest: grant.digest, reviewed: true, readConsent: "allow-exact-scheduled-read-operations-and-bounded-provider-calls", quotaConsent: "provider-requests-may-use-account-quota-or-incur-charges" });
    action = "pause"; await client.decide(grant, "pause", signal()); expect(calls[1]).toEqual({ expectedVersion: 1, digest: grant.digest, reviewed: true });
    fetcher.mockImplementation(async () => Response.json(automaticState({ ...grant, version: 3, state: "enabled" })));
    expect(await failure(client.decide(grant, "enable", signal()))).toContain("not confirmed");
  });
  it("accepts only metadata revocation for the exact stale grant after sources become unavailable", async () => {
    const grant = automaticGrant(); const fetcher = vi.fn(async () => Response.json({ ...automaticState(), available: false, canConfigure: false, staleGrant: { id: grant.id, version: 2, digest: grant.digest, state: "revoked", canRevoke: false } }));
    const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, fetcher); expect((await client.decide(grant, "revoke", signal())).staleGrant?.state).toBe("revoked"); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("verifies scheduled report hash independently and rejects changed content or addressed occurrence", async () => {
    const occurrence = automaticOccurrence(), report = automaticReport(occurrence);
    expect(report.reportHash).toBe(createHash("sha256").update(JSON.stringify(["shiba.automatic-read.report.v1", report.id, report.grantId, report.grantVersion, report.expiresAt, report.markdown, report.json])).digest("hex"));
    let next = report; const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, vi.fn(async () => Response.json(next)));
    expect(await client.report(occurrence, signal())).toEqual(report); next = { ...report, markdown: "Changed source" }; expect(await failure(client.report(occurrence, signal()))).toContain("exact bytes");
    next = { ...report, id: "another-occurrence" }; next.reportHash = founderAutomaticReadReportHash(next); expect(await failure(client.report(occurrence, signal()))).toContain("identity");
  });
  it("allows explicit authenticated private download only for the exact verified bytes", async () => {
    const occurrence = automaticOccurrence(), report = automaticReport(occurrence), fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(report.markdown));
    const client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, fetcher); expect(await client.download(report, occurrence, "markdown", signal())).toBe(report.markdown);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`/occurrences/${occurrence.id}/report/download?format=markdown`);
    fetcher.mockImplementation(async () => new Response("Unexpected body")); expect(await failure(client.download(report, occurrence, "markdown", signal()))).toContain("differs");
  });
  it("denies expired grant creation, already aborted work and unconfirmed HTTP without retry", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "changed" }, { status: 409 })), client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, fetcher);
    expect(await failure(client.configure({ ...automaticInput(), expiresAt: Date.now() - 1 }, signal()))).toContain("expiry");
    const controller = new AbortController(); controller.abort(); await failure(client.state(controller.signal)); expect(fetcher).not.toHaveBeenCalled();
    expect(await failure(client.state(signal()))).toContain("changed"); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("accepts an explicitly chosen weekly lease within28days without increasing occurrence, call or byte limits", async () => {
    const input = { ...automaticInput(), cadence: "weekly" as const, weekday: 1, expiresAt: Date.now() + 21 * 86_400_000 }, grant = automaticGrant(input);
    const send = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => Response.json(automaticState(grant))), client = new FounderAutomaticClient(AUTOMATIC_WORKSPACE, AUTOMATIC_LIBRARY, send);
    expect((await client.configure(input, signal())).grant?.contract).toMatchObject({ cadence: "weekly", weekday: 1, expiresAt: input.expiresAt, maxOccurrences: 2, maxCalls: 2, maxCapturedBytes: 65_536 });
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(await failure(client.configure({ ...input, expiresAt: Date.now() + 28 * 86_400_000 + 60_000 }, signal()))).toContain("28 days"); expect(send).toHaveBeenCalledTimes(1);
  });
});
