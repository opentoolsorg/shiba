import { afterEach, describe, expect, it, vi } from "vitest";
import { runInputHash, type DelegatedRun } from "@shiba/shared";
import { createRun } from "../src/runs.js";
import { deliverSlackCommandReply, saveSlackCommandReplyDestination, SlackCommandReplyUnknownError } from "../src/slack-command-reply.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({}) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const ORIGIN = "slack-command:T1:C1";
const fields = { repoUrl: "https://github.com/o/r", task: "Write the report.", baseBranch: "main", publishPullRequest: false };

function run(): DelegatedRun {
  return { ...createRun({ ...fields, runId: "agent-tool:approval-1", sandboxId: "sandbox", approval: {
    approvalId: "approval-1", decidedBy: "U1", decidedAt: Date.now(), inputHash: runInputHash(fields),
  } }), status: "completed" };
}

function bucket() {
  const objects = new Map<string, { text: string; etag: string; metadata: Record<string, string> }>();
  let sequence = 0;
  const storage = {
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value ? { size: new TextEncoder().encode(value.text).byteLength, etag: value.etag, customMetadata: value.metadata, text: async () => value.text } : null;
    }),
    put: vi.fn(async (key: string, body: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) => {
      const existing = objects.get(key);
      if (options?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
      if (options?.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
      const etag = String(++sequence);
      objects.set(key, { text: body, etag, metadata: options?.customMetadata ?? {} });
      return { key, etag };
    }),
  };
  return { objects, storage, env: { ATTACHMENTS: storage as unknown as R2Bucket, SLACK_BOT_TOKEN: "xoxb-worker-only" } };
}

async function prepared() {
  const context = bucket();
  await saveSlackCommandReplyDestination(context.env, { origin: ORIGIN, approvalId: "approval-1", approvalInputHash: runInputHash(fields), userId: "U-requester" });
  return context;
}

function slackFetch(reply: () => Promise<Response> = async () => Response.json({ ok: true, message_ts: "123.456" }), teamId = "T1") {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/auth.test")
    ? Response.json({ ok: true, team_id: teamId, user_id: "U-bot", bot_id: "B1" }) : reply());
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function delivery(overrides: Partial<Parameters<typeof deliverSlackCommandReply>[1]> = {}) {
  return { orchestratorName: "default", origin: ORIGIN, run: run(), effectId: "completion:approval-1", text: "Done. PR: https://github.com/o/r/pull/1", ...overrides };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("private slash command completion", () => {
  it("sends only to the verified requester and retains a receipt that makes replay a no-op", async () => {
    const { env, objects } = await prepared();
    const fetchImpl = slackFetch();
    await deliverSlackCommandReply(env, delivery());
    await deliverSlackCommandReply(env, delivery());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const post = fetchImpl.mock.calls.find((call) => String(call[0]).endsWith("/chat.postEphemeral"));
    expect(post).toBeDefined();
    const request = vi.mocked(fetch).mock.calls.find((call) => String(call[0]).endsWith("/chat.postEphemeral"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ channel: "C1", user: "U-requester", username: "Shiba Lead" });
    expect(JSON.parse(String(request?.[1]?.body))).not.toHaveProperty("thread_ts");
    expect([...objects.values()].some((value) => value.text.includes("xoxb-worker-only"))).toBe(false);
    expect([...objects.values()].some((value) => value.text.includes('"status":"sent"'))).toBe(true);
  });

  it.each([
    { origin: "slack-command:T2:C2" }, { orchestratorName: "another-owner" },
    { run: { ...run(), task: "Changed after approval." } },
    { run: { ...run(), runId: "agent-tool:other" } },
    { run: { ...run(), parentRunId: "parent" } },
  ])("refuses scope tampering before Slack access %j", async (overrides) => {
    const { env } = await prepared();
    const fetchImpl = slackFetch();
    await expect(deliverSlackCommandReply(env, delivery(overrides))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a bot installation from another workspace before writing a message", async () => {
    const { env } = await prepared();
    const fetchImpl = slackFetch(undefined, "T2");
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toThrow("another workspace");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retains an ambiguous write as unknown and never repeats it", async () => {
    const { env, objects } = await prepared();
    const fetchImpl = slackFetch(async () => { throw new Error("Lost response after acceptance."); });
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toBeInstanceOf(SlackCommandReplyUnknownError);
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toBeInstanceOf(SlackCommandReplyUnknownError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...objects.values()].some((value) => value.text.includes('"status":"unknown"'))).toBe(true);
  });

  it.each([408, 500, 503])("does not repeat an uncertain HTTP %s write", async (status) => {
    const { env } = await prepared();
    const fetchImpl = slackFetch(async () => Response.json({ ok: false, error: "internal_error" }, { status }));
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toBeInstanceOf(SlackCommandReplyUnknownError);
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toBeInstanceOf(SlackCommandReplyUnknownError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("allows a bounded outbox retry after an explicit Slack rejection", async () => {
    const { env } = await prepared();
    const reply = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, error: "user_not_in_channel" })).mockResolvedValueOnce(Response.json({ ok: true, message_ts: "123.456" }));
    const fetchImpl = slackFetch(reply);
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toThrow("user_not_in_channel");
    await deliverSlackCommandReply(env, delivery());
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails closed when the private receipt digest is corrupted or destination is missing", async () => {
    const { env, objects } = await prepared();
    const fetchImpl = slackFetch();
    const first = objects.values().next().value;
    if (!first) throw new Error("Expected saved destination.");
    first.text = first.text.replace("U-requester", "U-attacker");
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toThrow("digest");
    objects.clear();
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toThrow("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses changing an existing verified recipient", async () => {
    const { env } = await prepared();
    await expect(saveSlackCommandReplyDestination(env, { origin: ORIGIN, approvalId: "approval-1", approvalInputHash: runInputHash(fields), userId: "U-attacker" })).rejects.toThrow("already bound");
  });

  it("does not repeat a write when saving its accepted receipt fails", async () => {
    const { env, storage } = await prepared();
    const put = storage.put.getMockImplementation();
    if (!put) throw new Error("Expected storage implementation.");
    storage.put.mockImplementation(async (key, body, options) => {
      if ((JSON.parse(body) as { status?: string }).status === "sent") throw new Error("Injected receipt persistence failure.");
      return put(key, body, options);
    });
    const fetchImpl = slackFetch();
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toBeInstanceOf(SlackCommandReplyUnknownError);
    await expect(deliverSlackCommandReply(env, delivery())).rejects.toBeInstanceOf(SlackCommandReplyUnknownError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds Unicode text by bytes while retaining the completion link", async () => {
    const { env } = await prepared();
    slackFetch();
    const link = "https://shiba.test/download/signed-artifact";
    await deliverSlackCommandReply(env, delivery({ text: `${"🐶".repeat(2000)} Artifacts: ${link}` }));
    const request = vi.mocked(fetch).mock.calls.find((call) => String(call[0]).endsWith("/chat.postEphemeral"));
    const body = JSON.parse(String(request?.[1]?.body)) as { text: string };
    expect(new TextEncoder().encode(body.text).byteLength).toBeLessThan(4000);
    expect(body.text).toContain(link);
  });

  it("delivers after approval history is pruned and refuses a forged routing hint or replacement hash", async () => {
    const { env } = await prepared();
    const retained = { ...run(), slackCommandOrigin: ORIGIN };
    const held: Promise<unknown>[] = [];
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
      name: "default", env: { ...productionEnvStubs(), ...env }, state: { runs: [retained], pendingApprovals: [] },
      ctx: { waitUntil(promise: Promise<unknown>) { held.push(promise); } },
      setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
    });
    const fetchImpl = slackFetch();
    const post = instance as unknown as { postToThread(text: string, context: { runId: string; threadKey?: string }): void };
    post.postToThread("Completed after history pruning.", { runId: retained.runId });
    await Promise.all(held);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(instance.state.outbox?.[0]?.status).toBe("dispatched");
    expect(instance.state.pendingApprovals).toEqual([]);
    fetchImpl.mockClear();
    post.postToThread("Forged route.", { runId: retained.runId, threadKey: "slack-command:T2:C2" });
    await Promise.all(held);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(instance.state.outbox?.at(-1)?.lastError).toContain("does not match the approved run");
    if (!retained.approval) throw new Error("Expected approved fixture.");
    const forged = { ...retained, task: "Changed frozen task." };
    forged.approval = { ...retained.approval, inputHash: runInputHash(forged) };
    await expect(deliverSlackCommandReply(env, delivery({ run: forged }))).rejects.toThrow("does not match the approved run");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
