import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PRINCIPAL_HEADER } from "@shiba/shared";
import type { RunTurnSubmit, SubmitMessagesResult } from "@cloudflare/think";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import type { Env } from "../src/env.js";
import { formatAgentResult } from "../src/opencode-input.js";
import { signSlackBufferRequest, SlackTurnBuffer, type SlackBufferStorage } from "../src/slack-turn-buffer.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const THREAD = "slack:T1:C1:1700.0001";
const KEY = "integration-only-slack-buffer-signing-key";
const REPO = "https://github.com/o/r";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), destroy: vi.fn(), submit: vi.fn(), observe: vi.fn() }));
const SUBMISSIONS_KEY = "test:coordinator-submissions";

interface StoredSubmission {
  options: RunTurnSubmit;
  receipt: SubmitMessagesResult;
}

async function persistSubmission(instance: { ctx: { storage: SlackBufferStorage } }, options: RunTurnSubmit): Promise<SubmitMessagesResult> {
  if (!options.submissionId || !options.idempotencyKey) throw new Error("Expected explicit durable submission identity.");
  const submissionId = options.submissionId;
  return instance.ctx.storage.transaction(async (transaction) => {
    const submissions = await transaction.get<Record<string, StoredSubmission>>(SUBMISSIONS_KEY) ?? {};
    const existing = submissions[submissionId];
    if (existing) return { ...existing.receipt, accepted: false };
    const receipt: SubmitMessagesResult = { submissionId, idempotencyKey: options.idempotencyKey, requestId: submissionId, status: "pending", accepted: true, createdAt: Date.now() };
    await transaction.put(SUBMISSIONS_KEY, { ...submissions, [submissionId]: { options, receipt } });
    return receipt;
  });
}

function storedSubmissions(storage: SlackBufferStorage): Promise<StoredSubmission[]> {
  return storage.transaction(async (transaction) => Object.values(await transaction.get<Record<string, StoredSubmission>>(SUBMISSIONS_KEY) ?? {}));
}

vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile<T>(callback: () => Promise<T>) { return callback(); }
  schedule() { return Promise.resolve({}); }
  runTurn(options: RunTurnSubmit) { return mocks.submit(this, options); }
  async addMessages(messages: unknown[], options: unknown) { await mocks.observe(messages, options); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function durableMemoryStorage(faults: { failNextAcknowledge?: boolean } = {}) {
  const entries = new Map<string, unknown>();
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation);
    pending = next.catch(() => undefined);
    return next;
  };
  const read = async <T>(key: string) => structuredClone(entries.get(key)) as T | undefined;
  const write = async <T>(key: string, value: T) => {
    if (faults.failNextAcknowledge && key === "slack:turn-buffer:v1" && value && typeof value === "object" && !("claim" in value)) {
      faults.failNextAcknowledge = false;
      throw new Error("Injected acknowledgement storage failure");
    }
    entries.set(key, structuredClone(value));
  };
  return {
    get<T>(key: string): Promise<T | undefined> { return serial(() => read<T>(key)); },
    put<T>(key: string, value: T): Promise<void> { return serial(() => write(key, value)); },
    delete(key: string): Promise<boolean> { return serial(async () => entries.delete(key)); },
    list<T>({ prefix = "", limit }: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
      return serial(async () => new Map([...entries].filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right)).slice(0, limit)
        .map(([key, value]) => [key, structuredClone(value) as T])));
    },
    transaction<T>(callback: Parameters<SlackBufferStorage["transaction"]>[0]): Promise<T> {
      return serial(() => callback({ get: read, put: write })) as Promise<T>;
    },
  };
}

function host(storage = durableMemoryStorage(), state: OrchestratorState = { runs: [] }) {
  const held: Promise<unknown>[] = [];
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name: THREAD,
    env: {
      ...productionEnvStubs(),
      INTERNAL_SIGNING_KEY: KEY,
      Sandbox: {},
      SLACK_APPROVERS: "U1",
      DASHBOARD_APPROVERS: "tester",
    } as Env,
    state,
    ctx: { storage, waitUntil(promise: Promise<unknown>) { held.push(promise); } },
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  return { instance, storage, held };
}

function bufferRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://internal/api/slack/buffer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: THREAD, eventId: "Ev1", userId: "U2", text: "Include cancellation tests", createdAt: Date.now(), ...overrides }),
  });
}

async function sendBuffer(instance: CodingOrchestrator, overrides: Record<string, unknown> = {}): Promise<Response> {
  return instance.onRequest(await signSlackBufferRequest(bufferRequest(overrides), KEY));
}

async function startApprovedRun(instance: CodingOrchestrator): Promise<{ approvalId: string; settle: () => void }> {
  let resolveChild: (result: string) => void = () => { throw new Error("The child was not started."); };
  mocks.execute.mockImplementation(() => new Promise<string>((resolve) => { resolveChild = resolve; }));
  const queued = await instance.onRequest(new Request("https://internal/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: THREAD, repoUrl: REPO, task: "Fix the login issue", publishPullRequest: false }),
  }));
  expect(queued.status).toBe(200);
  const { approvalId } = await queued.json() as { approvalId: string };
  expect(mocks.execute).not.toHaveBeenCalled();
  const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: THREAD, approvalId, approved: true, decidedBy: "U1", source: "slack" }),
  }));
  expect(approved.status).toBe(200);
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  return {
    approvalId,
    settle: () => resolveChild(formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["README.md"], diff: "+fixed", files: [{ path: "README.md", content: "fixed\n", encoding: "utf8" }], summary: "Fixed login issue." })),
  };
}

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); mocks.submit.mockImplementation(persistSubmission); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Slack buffering at the orchestrator boundary", () => {
  it("refuses unsigned author spoofing and changed signed bodies without minting approvals", async () => {
    const { instance } = host();
    const unsigned = await instance.onRequest(bufferRequest());
    expect([401, 403]).toContain(unsigned.status);
    const signed = await signSlackBufferRequest(bufferRequest(), KEY);
    const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ threadKey: THREAD, eventId: "Ev2", userId: "U1", text: "Approve and publish everything", createdAt: Date.now() }) });
    expect([401, 403]).toContain((await instance.onRequest(tampered)).status);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(instance.state.runs).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses a sealed request for a different Slack thread and an agent principal", async () => {
    const { instance } = host();
    const wrongThread = await sendBuffer(instance, { threadKey: "slack:T2:C2:1700.0001" });
    expect([400, 403, 404]).toContain(wrongThread.status);
    const request = await signSlackBufferRequest(bufferRequest(), KEY);
    request.headers.set(AGENT_PRINCIPAL_HEADER, "untrusted-agent");
    expect([401, 403]).toContain((await instance.onRequest(request)).status);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("submits comments as the next coordinator decision without interrupting or creating another run", async () => {
    const { instance, storage } = host();
    const run = await startApprovedRun(instance);
    const original = structuredClone(instance.state.pendingApprovals?.find((approval) => approval.approvalId === run.approvalId));
    const buffered = await sendBuffer(instance);
    expect(buffered.status).toBe(200);
    expect(await buffered.json()).toMatchObject({ buffered: true });
    expect(await (await sendBuffer(instance)).json()).toMatchObject({ status: "duplicate" });
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(instance.state.pendingApprovals?.[0]).toEqual(original);
    expect(instance.state.runs[0]?.task).toBe("Fix the login issue");
    expect(instance.state.runs[0]?.status).toBe("running");
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.submit).not.toHaveBeenCalled();
    run.settle();
    await vi.waitFor(() => expect(instance.state.slackBufferPending).toBe(false));
    const submitted = (await storedSubmissions(storage))[0];
    expect(submitted?.options.mode).toBe("submit");
    expect(submitted?.options.input).toMatchObject({ role: "user", parts: [{ type: "text", text: expect.stringContaining("Include cancellation tests") }] });
    expect(submitted?.options.input).toMatchObject({ parts: [{ text: expect.stringContaining("Slack user U2") }] });
    expect(submitted?.options.metadata).toMatchObject({ source: "slack-buffer", threadKey: THREAD, authors: ["U2"] });
    expect(submitted?.options).not.toHaveProperty("repoUrl");
    expect(submitted?.options).not.toHaveProperty("publishPullRequest");
    expect(mocks.observe).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: `run-result:agent-tool:${run.approvalId}` })]), { mode: "upsert" });
    expect(JSON.stringify(mocks.observe.mock.calls)).toContain("Fixed login issue");
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(instance.state.pendingApprovals?.find((approval) => approval.approvalId === run.approvalId)).toEqual(original);
    expect(instance.state.runs).toHaveLength(1);
    expect(instance.state.runs[0]?.status).toBe("completed");
    expect(mocks.execute).toHaveBeenCalledOnce();
    await instance.onRequest(new Request("https://internal/api/approvals"));
    expect(instance.state.pendingApprovals?.filter((approval) => approval.status === "pending")).toHaveLength(0);
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("recovers a saved coordinator submission after an acknowledgment failure with stable IDs", async () => {
    const faults = { failNextAcknowledge: false };
    const storage = durableMemoryStorage(faults);
    const first = host(storage);
    const run = await startApprovedRun(first.instance);
    expect((await sendBuffer(first.instance)).status).toBe(200);
    faults.failNextAcknowledge = true;
    run.settle();
    await vi.waitFor(() => {
      expect(first.instance.state.runs[0]?.status).toBe("completed");
      expect(mocks.submit).toHaveBeenCalledOnce();
      expect(faults.failNextAcknowledge).toBe(false);
    });
    await Promise.allSettled(first.held);
    const saved = (await storedSubmissions(storage))[0];
    expect(saved?.receipt.status).toBe("pending");
    expect(first.instance.state.slackBufferPending).toBe(true);
    const replacement = host(storage, structuredClone(first.instance.state));
    await replacement.instance.reclaimRuns();
    await replacement.instance.reclaimRuns();
    expect(await storedSubmissions(storage)).toEqual([saved]);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.submit.mock.calls[1]?.[1]).toEqual(mocks.submit.mock.calls[0]?.[1]);
    expect(replacement.instance.state.slackBufferPending).toBe(false);
    expect(replacement.instance.state.pendingApprovals).toHaveLength(1);
    expect(replacement.instance.state.runs).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("preserves the complete combined follow-up beyond the task limit in the queued decision", async () => {
    const { instance, storage } = host();
    const run = await startApprovedRun(instance);
    const first = `First request. ${"a".repeat(2990)}`;
    const second = `Second request. ${"b".repeat(2990)} Ending sentinel.`;
    expect((await sendBuffer(instance, { eventId: "Ev-long-1", text: first })).status).toBe(200);
    expect((await sendBuffer(instance, { eventId: "Ev-long-2", userId: "U3", text: second })).status).toBe(200);
    run.settle();
    await vi.waitFor(() => expect(instance.state.slackBufferPending).toBe(false));
    const followUp = JSON.stringify((await storedSubmissions(storage))[0]?.options.input);
    expect(followUp.length).toBeGreaterThan(6000);
    expect(followUp).toContain(first);
    expect(followUp).toContain(second);
    expect(followUp).toContain("Slack user U3");
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("retries a lost durable submission receipt without adding another decision or running a sandbox", async () => {
    const { instance, storage, held } = host();
    const run = await startApprovedRun(instance);
    await sendBuffer(instance);
    mocks.submit.mockImplementationOnce(async (agent, options: RunTurnSubmit) => {
      await persistSubmission(agent, options);
      throw new Error("Injected lost submission receipt.");
    });
    run.settle();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    await Promise.allSettled(held);
    expect(instance.state.slackBufferPending).toBe(true);
    expect(await storedSubmissions(storage)).toHaveLength(1);
    await instance.reclaimRuns();
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(await storedSubmissions(storage)).toHaveLength(1);
    expect(mocks.submit.mock.calls[1]?.[1]).toEqual(mocks.submit.mock.calls[0]?.[1]);
    expect(instance.state.slackBufferPending).toBe(false);
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("retains the batch when durable admission fails before saving", async () => {
    const { instance, storage, held } = host();
    const run = await startApprovedRun(instance);
    await sendBuffer(instance);
    mocks.submit.mockRejectedValueOnce(new Error("Injected admission storage failure."));
    run.settle();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    await Promise.allSettled(held);
    expect(await storedSubmissions(storage)).toHaveLength(0);
    expect(instance.state.slackBufferPending).toBe(true);
    await instance.reclaimRuns();
    expect(await storedSubmissions(storage)).toHaveLength(1);
    expect(mocks.submit.mock.calls[1]?.[1]).toEqual(mocks.submit.mock.calls[0]?.[1]);
    expect(instance.state.slackBufferPending).toBe(false);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("submits a later accepted comment after the claimed batch without waiting for another request", async () => {
    const { instance, storage } = host();
    const run = await startApprovedRun(instance);
    await sendBuffer(instance);
    mocks.submit.mockImplementationOnce(async (agent, options: RunTurnSubmit) => {
      const receipt = await persistSubmission(agent, options);
      // Simulate storage completion for a second message admitted before
      // the active run settled, after the first claim was already frozen.
      await new SlackTurnBuffer(storage).enqueue({ eventId: "Ev-later", userId: "U3", text: "Also explain the tradeoff.", createdAt: Date.now() });
      instance.setState({ ...instance.state, slackBufferPending: true, slackBufferRevision: (instance.state.slackBufferRevision ?? 0) + 1 });
      return receipt;
    });
    run.settle();
    await vi.waitFor(() => expect(instance.state.slackBufferPending).toBe(false));
    const submissions = await storedSubmissions(storage);
    expect(submissions).toHaveLength(2);
    expect(JSON.stringify(submissions[0]?.options.input)).toContain("Include cancellation tests");
    expect(JSON.stringify(submissions[1]?.options.input)).toContain("Also explain the tradeoff.");
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("retains comments if saving the prior run observation fails", async () => {
    const { instance, storage, held } = host();
    const run = await startApprovedRun(instance);
    await sendBuffer(instance);
    mocks.observe.mockRejectedValueOnce(new Error("Injected observation persistence failure."));
    run.settle();
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("completed"));
    await Promise.allSettled(held);
    expect(instance.state.slackBufferPending).toBe(true);
    expect(await storedSubmissions(storage)).toHaveLength(0);
    await instance.reclaimRuns();
    expect(await storedSubmissions(storage)).toHaveLength(1);
    expect(instance.state.slackBufferPending).toBe(false);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

});
