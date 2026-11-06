import { describe, expect, it, vi } from "vitest";
import { FounderReconciliationSlackClient } from "./founder-reconciliation-slack-client";
import { SLACK_RECON_OWNER, SLACK_RECON_MANAGER, SLACK_RECON_WORKSPACE, reconciliationSlackFixture } from "./founder-reconciliation-slack-fixtures";
const signal = () => new AbortController().signal;
const failure = async (p: Promise<unknown>) => { try { await p; return "unexpected success"; } catch (e) { return e instanceof Error ? e.message : String(e); } };
describe("combined scheduled Slack client", () => {
  it("uses the native fetch receiver and workspace header", async () => {
    let init: RequestInit | undefined; const send: typeof fetch = async function (this: unknown, _path, options) { expect(this).toBe(globalThis); init = options; return Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, available: false, destinations: [], grants: [] }); };
    expect((await new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, send).discover(signal())).available).toBe(false); expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(SLACK_RECON_WORKSPACE); expect(init).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin" });
  });
  it("rejects foreign scope and a draft sample disclosed to another human", async () => {
    const { grant } = reconciliationSlackFixture(); let response: unknown = { workspaceId: SLACK_RECON_WORKSPACE, actorId: "other@example.test", available: true, destinations: [], grants: [] };
    const send = vi.fn(async () => Response.json(response)), client = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_MANAGER, send);
    expect(await failure(client.discover(signal()))).toContain("account or workspace changed"); response = { workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_MANAGER, grant }; expect(await failure(client.read(grant.id, signal()))).toContain("invalid");
  });
  it("allows minimal reductions even when full source access is unavailable", async () => {
    const { grant } = reconciliationSlackFixture(); const send = vi.fn(async () => Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, grant: { id: grant.id, digest: grant.digest, state: "revoked" } }));
    const client = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, send); expect((await client.reduce(grant, "revoke", signal())).state).toBe("revoked"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects an altered frozen schedule after owner consent", async () => {
    const { grant } = reconciliationSlackFixture(); const send = vi.fn(async () => Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, grant: { ...grant, state: "disclosed", schedule: { ...grant.schedule, maxSkewMinutes: 2 } } }));
    expect(await failure(new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, send).decide(grant, "disclose", signal()))).toContain("could not be verified");
  });
  it("allows current schedule counters to advance without changing the reviewed contract", async () => {
    const { grant } = reconciliationSlackFixture(); const next = { ...grant, state: "disclosed", schedule: { ...grant.schedule, usedComparisons: 1, nextDueAt: Date.now() + 1000 } };
    const client = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, async () => Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, grant: next }));
    expect((await client.decide(grant, "disclose", signal())).state).toBe("disclosed");
  });
  it("binds preparation to the selected scheduled sample and destination", async () => {
    const { grant } = reconciliationSlackFixture(), input = { requestId: crypto.randomUUID(), scheduleId: grant.schedule.id, sampleResultId: grant.sampleResultId, sampleHash: grant.sampleHash, roomId: grant.destination.roomId, linkId: grant.destination.linkId, maxSends: grant.maxSends, expiresAt: grant.expiresAt };
    const send = vi.fn(async () => Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, grant: { ...grant, sampleHash: "9".repeat(64) } }));
    expect(await failure(new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, send).prepare(input, signal()))).toContain("prepared delivery"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("blocks oversized UTF-8 samples, same-human approval and expired source leases", async () => {
    const { grant } = reconciliationSlackFixture(), send = vi.fn(async () => Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, grant: { ...grant, sampleContent: "é".repeat(1800) } })); const client = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, send);
    expect(await failure(client.read(grant.id, signal()))).toContain("invalid"); expect(await failure(client.decide({ ...grant, state: "disclosed" }, "approve", signal()))).toContain("distinct human"); grant.schedule.sourceGrants.stripe.expiresAt = Date.now() - 1; expect(await failure(client.decide(grant, "disclose", signal()))).toContain("review"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("refuses a successful acknowledgement after the reviewed lease expires", async () => {
    const { grant } = reconciliationSlackFixture(); let release!: (value: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; });
    const client = new FounderReconciliationSlackClient(SLACK_RECON_WORKSPACE, SLACK_RECON_OWNER, async () => held), pending = failure(client.decide(grant, "disclose", signal()));
    grant.schedule.sourceGrants.stripe.expiresAt = Date.now() - 1; release(Response.json({ workspaceId: SLACK_RECON_WORKSPACE, actorId: SLACK_RECON_OWNER, grant: { ...grant, state: "disclosed" } }));
    expect(await pending).toContain("could not be verified");
  });
});
