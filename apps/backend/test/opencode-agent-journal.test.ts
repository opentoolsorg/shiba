import type { JournalFrame } from "@shiba/sandbox";
import type { UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgent } from "../src/agents/opencode-agent.js";
import { sealChildDispatch } from "../src/child-dispatch.js";
import type { Env } from "../src/env.js";
import {
  type CodingTaskInput,
  type CodingTaskResult,
  formatAgentToolInput,
  parseAgentResultText,
} from "../src/opencode-input.js";
import { sealRunEnv } from "../src/run-env-seal.js";
import type { RunJournalBatch } from "../src/run-room-events.js";
import type { RuntimeAdapter } from "../src/runtime.js";
import type { PreparedRuntimeExecution } from "../src/runtime-recovery.js";
import { resetSandboxProviderCache } from "../src/sandbox/provider.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn<RuntimeAdapter["runCodingTask"]>(),
  sandbox: vi.fn(),
}));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("../src/sandbox/client.js", () => ({ getSandbox: mocks.sandbox }));
vi.mock("../src/runtime.js", () => ({
  createRuntimeAdapter: () => ({ runCodingTask: mocks.run }),
  resolveRuntimeName: (name?: string) => name ?? "sandbox",
}));

const KEY = "fe".repeat(32);
const OWNER = "owner@example.test";
const RESULT: CodingTaskResult = {
  status: "completed",
  exitCode: 0,
  stderrTail: "",
  changedFiles: [],
  diff: "",
  files: [],
  summary: "Done.",
};

function prepared(input: CodingTaskInput): PreparedRuntimeExecution {
  return {
    version: 1,
    phase: "harness",
    provider: "cloudflare",
    sandboxId: input.sandboxId,
    harness: "opencode",
    workdir: `/workspace/${input.sandboxId}`,
    approvalId: input.dispatchApprovalId!,
    inputHash: input.dispatchInputHash!,
    envelopeHash: input.dispatchEnvelopeHash!,
    commandIdentity: "b".repeat(64),
    jobId: "c".repeat(64),
    issuedAt: input.dispatchIssuedAt!,
    preparedAt: Date.now(),
    deadline: Date.now() + 60_000,
    recoveryDeadline: input.dispatchExpiresAt!,
    baseRevision: "a".repeat(40),
    baselineCommit: "b".repeat(40),
    setupCommit: null,
  };
}

/** Actual child, env opening and journal publisher; only the runtime and room RPC are fixtures. */
async function runJournal(
  values: Record<string, string>,
  chunks: Array<{ text: string; stream?: JournalFrame["stream"] }>,
  token?: string,
) {
  const sealed = await sealRunEnv(
    { MODEL_CREDENTIAL_KEY: KEY },
    OWNER,
    Object.entries(values).map(([name, value]) => ({ name, value })),
  );
  const base: CodingTaskInput = {
    repoUrl: "https://github.com/owner/repo",
    task: "Inspect the source.",
    baseBranch: "main",
    publishPullRequest: false,
    sandboxId: "run-abcdef12345678",
    codingModel: "google/gemini-3.5-flash-lite",
    envOwner: OWNER,
    envSealed: sealed.sealed,
    envDigest: sealed.digest,
    runRoom: { ownerId: OWNER, sessionId: "default", runId: "agent-tool:journal-test" },
  };
  const input = {
    ...base,
    ...(await sealChildDispatch(
      { MODEL_CREDENTIAL_KEY: KEY },
      {
        approvalId: "journal-test",
        sandboxId: base.sandboxId,
        inputHash: "a".repeat(64),
      },
      base,
    )),
  };
  const batches: RunJournalBatch[] = [];
  const room = {
    openRunJournal: vi.fn(async () => 0),
    appendRunJournalBatch: vi.fn(async (_identity: unknown, batch: RunJournalBatch) => {
      batches.push(structuredClone(batch));
      return batch.acknowledgedThrough;
    }),
    appendRunEvent: vi.fn(async () => 1),
  };
  const rows = new Map<string, unknown>();
  const instance = Object.assign(Object.create(OpenCodeAgent.prototype) as OpenCodeAgent, {
    env: {
      GITHUB_TOKEN: token,
      MODEL_CREDENTIAL_KEY: KEY,
      ConversationRoom: { getByName: () => room },
    } as unknown as Env,
    ctx: {
      storage: {
        async get<T>(key: string) {
          return structuredClone(rows.get(key)) as T | undefined;
        },
        async put(key: string, value: unknown) {
          rows.set(key, structuredClone(value));
        },
      },
    },
    messages: [
      { id: "input", role: "user", parts: [{ type: "text", text: formatAgentToolInput(input) }] },
    ],
    reportProgress: vi.fn(),
  });
  mocks.run.mockImplementation(async (_ops, _input, _emit, options) => {
    expect(options?.env).toEqual(values);
    if (
      !options?.onPrepared ||
      !options.onJournalFrame ||
      !options.onJournalEnd ||
      !options.onSettlementStarted
    ) {
      throw new Error("Expected the approved journal lifecycle.");
    }
    await options.onPrepared(prepared(input));
    for (const [index, chunk] of chunks.entries()) {
      await options.onJournalFrame({
        sequence: index + 1,
        stream: chunk.stream ?? "stdout",
        dataBase64: Buffer.from(chunk.text).toString("base64"),
      });
    }
    await options.onJournalEnd();
    await options.onSettlementStarted();
    return RESULT;
  });
  const response = await instance.onChatMessage(() => {}, { requestId: "journal-test" });
  const text = (await response!.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk)
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("");
  expect(parseAgentResultText(text).status).toBe("completed");
  expect(room.openRunJournal).toHaveBeenCalledOnce();
  expect(batches.at(-1)?.acknowledgedThrough).toBe(chunks.length);
  return batches.flatMap((batch) => batch.events.map(({ event }) => event));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetSandboxProviderCache();
  mocks.sandbox.mockReturnValue({});
});

describe("approved child journal redaction", () => {
  it("preserves plain terminal output with short env flags while scrubbing long approved values", async () => {
    const line = "test 1: true; 11 tests passed (CI=true, NODE_ENV=test, DEBUG=1)\n";
    const events = await runJournal(
      { DEBUG: "1", CI: "true", NODE_ENV: "test", APP_SECRET: "approved-private-value" },
      [{ text: line }, { text: "approved-private-" }, { text: "value\n", stream: "stdout" }],
    );
    expect(events).toEqual([
      { kind: "terminal", stream: "stdout", data: line },
      { kind: "terminal", stream: "stdout", data: "[redacted:APP_SECRET]\n" },
    ]);
  });

  it("applies short-value collision policy to each multiline fragment while scrubbing split long fragments and managed tokens", async () => {
    const token = "worker-managed-github-value";
    const secret = "first-private-line\n1\ntest\ntrue\nlast-private-line";
    const events = await runJournal(
      { APP_CERT: secret, DEBUG: "1", NODE_ENV: "test" },
      [
        { text: "test 1 is true\nfirst-pri" },
        { text: "vate-line\n1\ntest\ntrue\nlast-private-" },
        { text: "line\n" },
        { text: "worker-managed-", stream: "stderr" },
        { text: "github-value\n", stream: "stderr" },
        { text: `${JSON.stringify(secret)}\n` },
      ],
      token,
    );
    expect(
      events
        .filter((event) => event.stream === "stdout")
        .map((event) => event.data)
        .join(""),
    ).toBe('test 1 is true\n[redacted]\n1\ntest\ntrue\n[redacted]\n"[redacted:APP_CERT]"\n');
    expect(
      events
        .filter((event) => event.stream === "stderr")
        .map((event) => event.data)
        .join(""),
    ).toBe("[redacted]\n");
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain("first-private-line");
    expect(JSON.stringify(events)).not.toContain("last-private-line");
  });

  it("retains whole-value and JSON-escaped scrubbing when approved secrets contain quotes and backslashes", async () => {
    const secret = 'quoted-"private"-\\value';
    const events = await runJournal({ APP_SECRET: secret }, [
      { text: `raw ${secret}\njson ${JSON.stringify(secret)}\n` },
    ]);
    expect(events.map((event) => event.data).join("")).toBe(
      'raw [redacted:APP_SECRET]\njson "[redacted:APP_SECRET]"\n',
    );
  });

  it("scrubs multiline fragments before applying output bounds when another replacement expands the line", async () => {
    const events = await runJournal(
      { APP_CERT: "first-private-line\nlast-private-line", APP_SECRET: "12345678" },
      [{ text: "first-private-line 12345678\n" }],
    );
    expect(events.map((event) => event.data).join("")).toBe("[redacted] [redacted:APP_SECRET]\n");
  });
});
