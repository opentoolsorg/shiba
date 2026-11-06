/** Test-only entry. Native Container RPC is deliberately a fixed metadata fixture. */
import { DurableObject } from "cloudflare:workers";
import { ConversationRoom } from "../../src/conversation-room-do.js";
import { createRunJournalPublisher } from "../../src/run-journal-publisher.js";
import { runRoomName } from "../../src/run-room-events.js";
import { type ArchiveAuthorization, type ArchiveSource } from "../../src/run-output-archive.js";
import { prepareRunOutputArchive } from "../../src/run-output-archive-admission.js";
import { sealChildDispatch } from "../../src/child-dispatch.js";
import { newRunOutputArchivePolicy, resolveSandboxDurableObjectId, runInputHash } from "@shiba/shared";
import type { CodingTaskInput } from "../../src/opencode-input.js";
import type { PreparedRuntimeExecution } from "../../src/runtime-recovery.js";
import type { Env } from "../../src/env.js";
import type { JournalFrame } from "@shiba/sandbox";
export { ConversationRoom };
const OWNER = "journal-fixture@example.test", ACCOUNT = "native-archive-fixture", SANDBOX = "archive-replacement-fixture";
const EPOCH = "11111111-1111-4111-8111-111111111111";
const identity = { ownerId: OWNER, sessionId: "default", runId: "agent-tool:archive-approval" };
type Config = { auth: ArchiveAuthorization; source: ArchiveSource };
export class ArchiveFixtureSource extends DurableObject<Env> {
  async configure(value: Config) { if (this.ctx.storage.kv.get("config")) throw new Error("Already configured"); this.ctx.storage.kv.put("config", value); }
  async config(): Promise<Config> { const value = this.ctx.storage.kv.get<Config>("config"); if (!value) throw new Error("Not configured"); return value; }
  async getExecutionClaim() { return (await this.config()).source; }
  async startExecution() { this.ctx.storage.kv.put("forbidden-start-count", (this.ctx.storage.kv.get<number>("forbidden-start-count") ?? 0) + 1); throw new Error("Replacement recovery must never START"); }
  async replace() { const value = await this.config(); this.ctx.storage.kv.put("config", { ...value, source: { ...value.source, currentEpoch: "22222222-2222-4222-8222-222222222222", state: "lost" } }); }
  async stats() { return { starts: this.ctx.storage.kv.get<number>("forbidden-start-count") ?? 0 }; }
}
type FixtureEnv = Env & { FIXTURE_JOB: string };
const sourceStub = (env: FixtureEnv) => env.Sandbox.get(resolveSandboxDurableObjectId(env.Sandbox, SANDBOX)) as unknown as DurableObjectStub<ArchiveFixtureSource>;
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url), source = sourceStub(env), room = env.ConversationRoom.getByName(runRoomName(OWNER, "default"));
    try {
      if (url.pathname === "/network-probe") return Response.json({ status: (await fetch("https://example.invalid/fixture-network-probe")).status });
      if (url.pathname === "/setup" && request.method === "POST") {
        const body = await request.json() as { digest: string; commandIdentity: string; deadline: number };
        if (!/^[a-f0-9]{64}$/.test(body.digest) || !/^[a-f0-9]{64}$/.test(body.commandIdentity)) throw new Error("Invalid fixed source metadata");
        const input: CodingTaskInput = { repoUrl: "https://github.com/fixture/repo", task: "Fixed offline replacement fixture", baseBranch: "main", publishPullRequest: false,
          sandboxId: SANDBOX, codingModel: "fixture/model", runtime: "sandbox", sandboxProvider: "cloudflare", accessAgent: OWNER, initiatorUserId: OWNER,
          runRoom: identity, outputArchive: newRunOutputArchivePolicy(Date.now(), ACCOUNT) };
        Object.assign(input, await sealChildDispatch(env, { approvalId: "archive-approval", sandboxId: SANDBOX, inputHash: runInputHash(input) }, input));
        const capsule: PreparedRuntimeExecution = { version: 1, phase: "harness", provider: "cloudflare", sandboxId: SANDBOX, harness: "fixture", workdir: "/workspace/fixture",
          approvalId: input.dispatchApprovalId!, inputHash: input.dispatchInputHash!, envelopeHash: input.dispatchEnvelopeHash!, commandIdentity: body.commandIdentity,
          jobId: env.FIXTURE_JOB, issuedAt: input.dispatchIssuedAt!, preparedAt: Date.now(), deadline: body.deadline, recoveryDeadline: input.dispatchExpiresAt!,
          baseRevision: "a".repeat(40), baselineCommit: "b".repeat(40), setupCommit: null };
        const auth = await prepareRunOutputArchive(env, input, capsule);
        await source.configure({ auth, source: { jobId: env.FIXTURE_JOB, digest: body.digest, epoch: EPOCH, currentEpoch: EPOCH, deadline: body.deadline, state: "running" } });
        await room.openRunJournal(identity, { jobId: env.FIXTURE_JOB, generation: capsule.envelopeHash, archive: auth });
        return Response.json({ archiveId: auth.reservation.id });
      }
      const config = await source.config(), journal = { jobId: env.FIXTURE_JOB, generation: config.auth.reservation.envelopeHash, archive: config.auth };
      if (url.pathname === "/socket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") return room.fetch(new Request("http://fixture.internal/socket", { headers: {
        Upgrade: "websocket", "x-shiba-room-owner": OWNER, "x-shiba-room-actor": OWNER, "x-shiba-room-session": "default", "x-shiba-room-viewer": "22222222-2222-4222-8222-222222222222", "x-shiba-room-readonly": "true", "x-shiba-room-run": identity.runId,
      } }));
      if (url.pathname === "/archive") return Response.json(await room.readRunOutputArchive(identity, config.auth.reservation.id, ACCOUNT, Number(url.searchParams.get("after") ?? 0)));
      if (url.pathname === "/stats") return Response.json(await source.stats());
      if (url.pathname === "/replace" && request.method === "POST") { await source.replace(); return Response.json({ replaced: true }); }
      if (url.pathname === "/revoke" && request.method === "POST") { await env.AGENT_AUDIT.prepare("UPDATE run_output_archive_reservations SET state='revoked'").run(); return Response.json({ revoked: true }); }
      if (url.pathname !== "/publish" || request.method !== "POST") return new Response("Fixture route not found", { status: 404 });
      const body = await request.json() as { frames: JournalFrame[]; loseAck?: boolean };
      if (!Array.isArray(body.frames) || body.frames.length > 64) throw new Error("Fixed source frame limit");
      let lost = 0;
      const proxy = { openRunJournal: (...args: Parameters<typeof room.openRunJournal>) => room.openRunJournal(...args),
        async appendRunJournalBatch(...args: Parameters<typeof room.appendRunJournalBatch>) { const ack = await room.appendRunJournalBatch(...args); if (body.loseAck && lost++ < 2) throw new Error("Committed reply lost"); return ack; } };
      const publisher = await createRunJournalPublisher({ ...env, ConversationRoom: { getByName: () => proxy } } as unknown as Env,
        identity, journal, (text) => text.replaceAll("fixture-secret-value", "[fixture-redacted]"));
      try { for (const frame of body.frames) await publisher.accept(frame); }
      catch (error) { if (body.loseAck && lost === 2) return Response.json({ injected: "committed-acknowledgment-loss" }, { status: 503 }); throw error; }
      return Response.json({ acknowledged: publisher.acknowledgedThrough });
    } catch { return Response.json({ error: "Fixture archive operation refused" }, { status: 409 }); }
  },
};
