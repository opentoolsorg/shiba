/**
 * Channel acceptance matrix harness. One suite of security-invariant tests
 * every chat lane must pass, parameterized per channel so a new platform
 * plugs in one row instead of re-deriving the matrix. Test-only: nothing in
 * the Worker bundle imports this module.
 *
 * Invariants covered (docs/architecture/security-model.md):
 * - signature/auth: every lane authenticates its own deliveries and fails
 *   closed when its secrets are unset.
 * - dedupe: one redelivered delivery produces at most one unit of work.
 * - no execution before approval: intake only mints a pending approval;
 *   the publication executor refuses anything but a current human decision.
 * - approver binding: a decision only counts from the channel's own
 *   allowlisted human, never from another channel's prefix or an agent.
 * - result/postback shape: approval cards and decision lines carry the exact
 *   frozen input, bounded to platform message caps.
 * - publication pointer bounds: decision pointers and staged publication
 *   payloads are strict, bounded, and scope-checked.
 */
import { describe, expect, it, vi } from "vitest";
import { APPROVAL_TTL_MS, type PendingApproval } from "@shiba/shared";
import {
  CARD_TASK_LIMIT,
  chatApprovalText,
  createSeenRing,
  decideChatApproval,
  decisionLine,
  postToChatThread,
  queueChatRun,
  type OrchestratorStub,
} from "../../src/chat-lane.js";
import type { Env } from "../../src/env.js";
import type { CodingTaskResult } from "../../src/opencode-input.js";
import type { ChannelDefinition } from "../../src/ports/channel/index.js";
import {
  executePrPublishApproval,
  MAX_PR_PUBLISH_STAGE_BYTES,
  stagePrPublishApproval,
  validatePrPublicationProposal,
} from "../../src/pr-publish-approval.js";
import { buildApprovalValue, parseApprovalValue } from "../../src/slack-approval.js";

export type AcceptanceChannelId = "slack" | "discord" | "teams" | "telegram";
export type ApproverEnvKey = "SLACK_APPROVERS" | "TELEGRAM_APPROVERS" | "DISCORD_APPROVERS" | "TEAMS_APPROVERS";

/**
 * Lane-level ingress fixture: the real webhook handler with its platform
 * authentication, backed by recording fakes. Optional per channel — lanes
 * whose ingress is covered elsewhere may omit it, but the matrix then proves
 * nothing about that lane's replay handling.
 */
export interface LaneAcceptanceFixture {
  /** Reset in-memory and fake durable dedupe state between tests. */
  reset(): void;
  /** A correctly authenticated delivery that queues exactly one run. Reproducible: every call carries the same delivery id. */
  signedTaskRequest(): Promise<Request>;
  /** The same delivery with its authentication stripped or broken. */
  unsignedTaskRequest(): Promise<Request>;
  handle(request: Request): Promise<Response | null>;
  /** Units of work the delivery triggered (queued runs or dispatched events). */
  workCount(): number;
}

export interface ChannelAcceptanceRow {
  channel: AcceptanceChannelId;
  definition: ChannelDefinition;
  /** Env with every required secret and the outbound token set. */
  env: Env;
  /** The platform authenticates the delivery rather than the body bytes. */
  bodyUnsigned?: boolean;
  sign(rawBody: string): Promise<Headers>;
  message: { rawBody: string; deliveryId: string; conversationKey: string };
  action: { rawBody: string; deliveryId: string; conversationKey: string };
  /** Approver binding: the lane records decisions as `decider` for `platformUserId`. */
  approverEnvKey: ApproverEnvKey;
  platformUserId: string;
  decider: string;
  lane?: LaneAcceptanceFixture;
}

const BASE_REVISION = "a".repeat(40);

/** Fake R2 + GitHub API so the real publication executor can run end to end. */
export function createPublicationExecutorHarness() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const env = {
    ATTACHMENTS: {
      put: async (key: string, body: Uint8Array<ArrayBuffer>) => {
        if (objects.has(key)) return null;
        objects.set(key, new Uint8Array(body));
        return { key };
      },
      get: async (key: string) => {
        const body = objects.get(key);
        return body ? { size: body.byteLength, arrayBuffer: async () => new Uint8Array(body).buffer } : null;
      },
    },
    GITHUB_TOKEN: "ghp_acceptance_fixture_token",
  } as unknown as Env;
  const githubCalls: string[] = [];
  const fetchImpl = vi.fn(async (resource: RequestInfo | URL) => {
    const url = String(resource);
    githubCalls.push(url);
    const response = (value: unknown) => Response.json(value);
    if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: BASE_REVISION } });
    if (url.endsWith(`/git/commits/${BASE_REVISION}`)) return response({ tree: { sha: "base-tree" } });
    if (url.endsWith("/git/blobs")) return response({ sha: "blob" });
    if (url.endsWith("/git/trees")) return response({ sha: "tree" });
    if (url.endsWith("/git/commits")) return response({ sha: "commit" });
    if (url.endsWith("/git/refs")) return response({});
    if (url.endsWith("/pulls")) return response({ html_url: "https://github.com/owner/repo/pull/7", number: 7 });
    throw new Error(`Unexpected publication request ${url}.`);
  });
  const scope = { ownerId: "owner@example.com", runId: "run-acceptance", sandboxId: "sandbox", repoUrl: "https://github.com/owner/repo", baseBranch: "main" };
  const result: CodingTaskResult = {
    baseRevision: BASE_REVISION, status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["source.ts"],
    diff: "", summary: "Task completed.", files: [{ path: "source.ts", content: "bytes", encoding: "utf8" }],
  };
  const stage = () => stagePrPublishApproval(env, { ...scope, task: "Fix source.", result });
  return { env, objects, fetchImpl, githubCalls, scope, stage };
}

function approvalFrom(proposal: Awaited<ReturnType<typeof stagePrPublishApproval>>, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return { ...proposal, status: "approved", decidedBy: "owner@example.com", decidedAt: Date.now(), ...overrides };
}

/** Recording orchestrator stub: every lane-plumbing call lands here. */
export function createRecordingOrchestrator(approvalId = "approval-acceptance") {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      calls.push({ path, body });
      if (path.endsWith("/api/runs")) return Response.json({ ok: true, approvalId, route: "opencode" });
      if (path.endsWith("/api/approvals")) return Response.json({ result: body.approved ? "approved" : "rejected" });
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  return { calls, stub, resolve: async () => stub };
}

/**
 * Per-channel invariant rows: signature/auth, dedupe key stability,
 * lane-level replay and pre-auth refusal, and approver binding through the
 * real publication executor.
 */
export function runChannelAcceptanceSuite(name: string, makeRow: () => ChannelAcceptanceRow | Promise<ChannelAcceptanceRow>): void {
  const row = async () => makeRow();

  describe(`channel acceptance: ${name}`, () => {
  describe("signature/auth", () => {
    it("accepts a correctly authenticated delivery", async () => {
      const r = await row();
      const body = r.message.rawBody;
      expect(await r.definition.transport.verify(body, await r.sign(body), r.env)).toEqual({ ok: true });
    });

    it("fails closed with 503 when the lane's secrets are unset", async () => {
      const r = await row();
      const body = r.message.rawBody;
      expect(await r.definition.transport.verify(body, await r.sign(body), {} as Env)).toMatchObject({ ok: false, status: 503 });
    });

    it("refuses a delivery with no authentication headers before any parsing", async () => {
      const r = await row();
      expect(await r.definition.transport.verify(r.message.rawBody, new Headers(), r.env)).toMatchObject({ ok: false, status: 401 });
    });

    it("rejects a tampered body where the platform signs the bytes", async () => {
      const r = await row();
      const body = r.message.rawBody;
      // Tamper inside the user text so auth-relevant structure (envelope,
      // serviceUrl) stays intact — the point is the signature, not the JSON.
      const tampered = body.replace("fix", "mux");
      expect(tampered).not.toBe(body);
      const verdict = await r.definition.transport.verify(tampered, await r.sign(body), r.env);
      if (r.bodyUnsigned) expect(verdict.ok).toBe(true);
      else expect(verdict).toMatchObject({ ok: false, status: 401 });
    });
  });

  describe("dedupe", () => {
    it("parses stable, non-empty, distinct delivery ids for messages and actions", async () => {
      const r = await row();
      const first = r.definition.transport.parse(r.message.rawBody);
      const second = r.definition.transport.parse(r.message.rawBody);
      expect(first?.deliveryId).toBe(r.message.deliveryId);
      expect(second?.deliveryId).toBe(r.message.deliveryId);
      expect(r.message.deliveryId).not.toBe("");
      const action = r.definition.transport.parse(r.action.rawBody);
      expect(action?.deliveryId).toBe(r.action.deliveryId);
      expect(action?.deliveryId).not.toBe(r.message.deliveryId);
    });

    it("namespaces conversation keys with the channel prefix so lanes never collide", async () => {
      const r = await row();
      expect(r.message.conversationKey.startsWith(`${r.channel}:`)).toBe(true);
      expect(r.action.conversationKey.startsWith(`${r.channel}:`)).toBe(true);
      const event = r.definition.transport.parse(r.message.rawBody);
      expect(event && r.definition.transport.conversationKey(event)).toBe(r.message.conversationKey);
    });

    it("a replayed authenticated delivery triggers at most one unit of work", async () => {
      const r = await row();
      if (!r.lane) return;
      r.lane.reset();
      const first = await r.lane.handle(await r.lane.signedTaskRequest());
      expect(first?.status).toBe(200);
      const work = r.lane.workCount();
      expect(work).toBe(1);
      const replay = await r.lane.handle(await r.lane.signedTaskRequest());
      expect(replay?.status).toBe(200);
      expect(r.lane.workCount()).toBe(work);
    });

    it("an unauthenticated delivery is refused before any work", async () => {
      const r = await row();
      if (!r.lane) return;
      r.lane.reset();
      const response = await r.lane.handle(await r.lane.unsignedTaskRequest());
      expect(response?.status).toBe(401);
      expect(r.lane.workCount()).toBe(0);
    });
  });

  describe("approver binding", () => {
    it("executes publication only for the channel's own allowlisted human decider", async () => {
      const r = await row();
      const harness = createPublicationExecutorHarness();
      harness.env[r.approverEnvKey] = r.platformUserId;
      const proposal = await harness.stage();
      const published = await executePrPublishApproval(
        harness.env, approvalFrom(proposal, { decidedBy: r.decider }), harness.scope, { fetchImpl: harness.fetchImpl },
      );
      expect(published.pullUrl).toBe("https://github.com/owner/repo/pull/7");
    });

    it("refuses a decider missing from the channel allowlist", async () => {
      const r = await row();
      const harness = createPublicationExecutorHarness();
      harness.env[r.approverEnvKey] = "somebody-else";
      const proposal = await harness.stage();
      await expect(
        executePrPublishApproval(harness.env, approvalFrom(proposal, { decidedBy: r.decider }), harness.scope, { fetchImpl: harness.fetchImpl }),
      ).rejects.toThrow("authorized human");
      expect(harness.fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses agent and system deciders even when the id is allowlisted", async () => {
      const r = await row();
      const harness = createPublicationExecutorHarness();
      harness.env[r.approverEnvKey] = r.platformUserId;
      const proposal = await harness.stage();
      for (const forged of [`agent:${r.decider}`, `system:${r.decider}`, "automation:cron"]) {
        await expect(
          executePrPublishApproval(harness.env, approvalFrom(proposal, { decidedBy: forged }), harness.scope, { fetchImpl: harness.fetchImpl }),
        ).rejects.toThrow();
      }
      expect(harness.fetchImpl).not.toHaveBeenCalled();
    });
  });
  });
}

/**
 * Matrix-wide invariants shared by every lane: cross-channel approver
 * isolation, intake that only mints approvals, postback shape and bounds,
 * and publication pointer bounds. Rows resolve lazily because some lanes
 * need async key material; every test awaits the same memoized promise.
 */
export function runChannelAcceptanceMatrix(makeRows: () => Promise<ChannelAcceptanceRow[]>): void {
  describe("cross-channel isolation", () => {
    it("no two lanes can ever share a conversation key", async () => {
      const rows = await makeRows();
      expect(rows.length).toBeGreaterThan(1);
      for (const a of rows) {
        for (const b of rows) {
          if (a.channel === b.channel) continue;
          const aKeys = new Set([a.message.conversationKey, a.action.conversationKey]);
          for (const key of [b.message.conversationKey, b.action.conversationKey]) {
            expect(aKeys.has(key)).toBe(false);
          }
        }
      }
    });

    it("an approver allowlisted on one channel cannot decide through another channel's prefix", async () => {
      const rows = await makeRows();
      expect(rows.length).toBeGreaterThan(1);
      for (const listed of rows) {
        for (const intruder of rows) {
          if (intruder.channel === listed.channel) continue;
          const harness = createPublicationExecutorHarness();
          harness.env[listed.approverEnvKey] = listed.platformUserId;
          const proposal = await harness.stage();
          // The intruder's decider string embeds the attacker's channel prefix;
          // being on `listed`'s allowlist must never authorize it.
          await expect(
            executePrPublishApproval(
              harness.env, approvalFrom(proposal, { decidedBy: intruder.decider }), harness.scope, { fetchImpl: harness.fetchImpl },
            ),
          ).rejects.toThrow();
          expect(harness.fetchImpl).not.toHaveBeenCalled();
        }
      }
    });
  });

  describe("no execution before approval", () => {
    it("intake only ever posts to /api/runs and surfaces the minted approval id", async () => {
      for (const platform of ["telegram", "discord", "teams"] as const) {
        const recording = createRecordingOrchestrator();
        const queued = await queueChatRun(
          {} as Env,
          { platform, threadKey: `${platform}:1`, repoUrl: "https://github.com/owner/repo", task: "fix it", userId: "u" },
          recording.resolve,
        );
        expect(queued).toMatchObject({ approvalId: "approval-acceptance" });
        expect(recording.calls).toHaveLength(1);
        expect(recording.calls[0]?.path).toBe("/api/runs");
        expect(recording.calls[0]?.body).toMatchObject({ publishPullRequest: true, source: platform });
      }
    });

    it("queues nothing when the orchestrator cannot mint an approval", async () => {
      const recording = createRecordingOrchestrator();
      const failing: OrchestratorStub = { fetch: async () => Response.json({ error: "no GITHUB_TOKEN" }, { status: 500 }) };
      const queued = await queueChatRun(
        {} as Env,
        { platform: "telegram", threadKey: "telegram:1", repoUrl: "https://github.com/owner/repo", task: "fix it", userId: "u" },
        async () => failing,
      );
      expect(queued).toMatchObject({ error: "no GITHUB_TOKEN" });
      expect(recording.calls).toHaveLength(0);
    });

    it("a replayed or expired decision resolves nothing", async () => {
      const stub: OrchestratorStub = { fetch: async () => Response.json({ result: "unknown" }) };
      const decision = await decideChatApproval(
        {} as Env,
        { platform: "discord", threadKey: "discord:1", approvalId: "a", approved: true, decidedBy: "discord:1" },
        async () => stub,
      );
      expect(decision).toMatchObject({ ok: false });
    });

    it("the publication executor refuses anything but a current, unexecuted human approval", async () => {
      const harness = createPublicationExecutorHarness();
      harness.env.SLACK_APPROVERS = "U1";
      const proposal = await harness.stage();
      const base = approvalFrom(proposal, { decidedBy: "U1" });
      const now = Date.now();
      const refused: Partial<PendingApproval>[] = [
        { status: "pending" },
        { status: "rejected" },
        { execution: { startedAt: now } as never },
        { decidedBy: "" },
        { decidedBy: "  " },
        { decidedBy: `U1\n` },
        { decidedBy: "x".repeat(513) },
        { decidedAt: now + 60_000 },
        { decidedAt: 0 },
        { createdAt: now - APPROVAL_TTL_MS - 1, decidedAt: now - APPROVAL_TTL_MS - 1 },
      ];
      for (const overrides of refused) {
        await expect(
          executePrPublishApproval(harness.env, { ...base, ...overrides }, harness.scope, { fetchImpl: harness.fetchImpl }),
        ).rejects.toThrow();
      }
      expect(harness.fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("result/postback shape", () => {
    it("the approval card carries the exact repo, task, approval id and publication notice within bounds", () => {
      const text = chatApprovalText({ repoUrl: "https://github.com/owner/repo", task: "fix it", approvalId: "a1", publishPullRequest: true });
      expect(text).toContain("https://github.com/owner/repo");
      expect(text).toContain("fix it");
      expect(text).toContain("approval a1");
      expect(text).toContain("separate approval");
      const long = chatApprovalText({ repoUrl: "", task: "x".repeat(CARD_TASK_LIMIT + 500), approvalId: "a2" });
      expect(long).toContain("more chars");
      expect(long.length).toBeLessThan(CARD_TASK_LIMIT + 500);
    });

    it("the decision line names the decider and whether a run started", () => {
      expect(decisionLine(true, "Ana")).toBe("Approved by Ana — run starting.");
      expect(decisionLine(false, "Ana")).toBe("Rejected by Ana — no run started.");
    });

    it("postbacks are capped per platform and never leak into web or unknown threads", async () => {
      const posted: { url: string; body: string }[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        posted.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
        return Response.json({ ok: true, result: { message_id: 1 }, channel: "C1", ts: "1.1", id: "1" });
      }) as typeof fetch;
      try {
        const env = { SLACK_BOT_TOKEN: "x", TELEGRAM_BOT_TOKEN: "t", DISCORD_BOT_TOKEN: "d" } as Env;
        const oversized = "y".repeat(5000);
        await postToChatThread(env, "telegram:-100", oversized);
        await postToChatThread(env, "discord:123", oversized);
        const telegramBody = JSON.parse(posted.find((p) => p.url.includes("telegram"))?.body ?? "{}") as { text?: string };
        const discordBody = JSON.parse(posted.find((p) => p.url.includes("discord"))?.body ?? "{}") as { content?: string };
        expect(telegramBody.text?.length).toBeLessThanOrEqual(4000);
        expect(discordBody.content?.length).toBeLessThanOrEqual(2000);
        const before = posted.length;
        expect(postToChatThread(env, "web:abc", "hi")).toBeNull();
        expect(postToChatThread(env, "email:x", "hi")).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(posted.length).toBe(before);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe("publication pointer bounds", () => {
    it("decision pointers round-trip and reject malformed values", () => {
      const pointer = { threadKey: "slack:T:C:1", approvalId: "a1" };
      expect(parseApprovalValue(buildApprovalValue(pointer))).toEqual(pointer);
      for (const bad of ["not json", "{}", "null", JSON.stringify({ threadKey: "", approvalId: "a" }), JSON.stringify({ threadKey: "t" })]) {
        expect(() => parseApprovalValue(bad)).toThrow();
      }
    });

    it("the proposal schema pins an immutable approval id, bounded digests and strict shape", async () => {
      const harness = createPublicationExecutorHarness();
      const proposal = await harness.stage();
      expect(proposal.approvalId).toBe(`pr-publish:${harness.scope.runId}`);
      expect(() => validatePrPublicationProposal(proposal, harness.scope)).not.toThrow();
      const mutations: Array<Record<string, unknown>> = [
        { ...proposal, approvalId: "pr-publish:other-run" },
        { ...proposal, payload: { ...proposal.payload, artifactKey: "pr-publish-staging/../../etc.json" } },
        { ...proposal, payload: { ...proposal.payload, sha256: "z".repeat(64) } },
        { ...proposal, payload: { ...proposal.payload, bytes: MAX_PR_PUBLISH_STAGE_BYTES + 1 } },
        { ...proposal, payload: { ...proposal.payload, fileCount: 51 } },
        { ...proposal, payload: { ...proposal.payload, runId: "another-run" } },
        { ...proposal, extra: true },
      ];
      for (const mutation of mutations) {
        expect(() => validatePrPublicationProposal(mutation, harness.scope)).toThrow();
      }
    });

    it("the executor never widens scope: a proposal for another run or repo is refused", async () => {
      const harness = createPublicationExecutorHarness();
      harness.env.SLACK_APPROVERS = "U1";
      const proposal = await harness.stage();
      for (const wrong of [
        { ...harness.scope, runId: "run-other" },
        { ...harness.scope, repoUrl: "https://github.com/owner/other" },
        { ...harness.scope, ownerId: "other@example.com" },
      ]) {
        await expect(
          executePrPublishApproval(harness.env, approvalFrom(proposal, { decidedBy: "U1" }), wrong, { fetchImpl: harness.fetchImpl }),
        ).rejects.toThrow();
      }
      expect(harness.fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("delivery dedupe bookkeeping", () => {
    it("the seen ring is bounded and evicts the oldest id first", () => {
      const ring = createSeenRing(3);
      ring.add("a"); ring.add("b"); ring.add("c");
      expect(ring.has("a")).toBe(true);
      ring.add("d");
      expect(ring.has("a")).toBe(false);
      expect(ring.has("d")).toBe(true);
      ring.clear();
      expect(ring.has("d")).toBe(false);
    });
  });
}
