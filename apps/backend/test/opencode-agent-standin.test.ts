import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgent } from "../src/agents/opencode-agent.js";
import { formatAgentToolInput, parseAgentResultText, type CodingTaskInput } from "../src/opencode-input.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), publish: vi.fn(), sandbox: vi.fn(), progress: vi.fn() }));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: mocks.sandbox, streamFile: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: vi.fn() } }));
vi.mock("../src/runtime.js", () => ({
  createRuntimeAdapter: () => ({ runCodingTask: mocks.run }),
  resolveRuntimeName: (name?: string) => name ?? "sandbox",
}));
vi.mock("../src/github.js", () => ({ publishFilesAsPullRequest: mocks.publish }));

const MOCK_BASE = "http://127.0.0.1:4010";
const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo", task: "Fix it.", baseBranch: "main",
  publishPullRequest: true, sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

function agent(input: CodingTaskInput, env: Record<string, string | undefined>) {
  return Object.assign(Object.create(OpenCodeAgent.prototype) as OpenCodeAgent, {
    env,
    messages: [{ id: "input", role: "user", parts: [{ type: "text", text: formatAgentToolInput(input) }] }],
    reportProgress: mocks.progress,
  });
}

async function run(instance: OpenCodeAgent, signal?: AbortSignal) {
  const response = await instance.onChatMessage(() => {}, { requestId: "test", abortSignal: signal });
  const text = (await response!.text()).split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string })
    .filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("");
  return { text, result: parseAgentResultText(text) };
}

const STANDIN_ENV = { GITHUB_TOKEN: "mock-token", GITHUB_API_BASE: MOCK_BASE, SHIBA_VERIFY_STANDIN: "1" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sandbox.mockReturnValue({});
  mocks.publish.mockResolvedValue({ pullUrl: `${MOCK_BASE}/owner/repo/pull/1`, pullNumber: 1 });
});

describe("verify stand-in agent safety", () => {
  it("completes without a sandbox or runtime and publishes to the loopback mock only", async () => {
    const { result } = await run(agent(INPUT, STANDIN_ENV));
    expect(result.status).toBe("completed");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.sandbox).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ path: "README.md" })] }),
      { apiBase: MOCK_BASE },
    );
  });

  it("does not publish when the approved input did not request a pull request", async () => {
    const { result } = await run(agent({ ...INPUT, publishPullRequest: false }, STANDIN_ENV));
    expect(result.status).toBe("completed");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses a requested publish without credentials before any synthetic work", async () => {
    const { result } = await run(agent(INPUT, { ...STANDIN_ENV, GITHUB_TOKEN: undefined }));
    expect(result).toMatchObject({ status: "error" });
    expect(result.summary).toContain("GITHUB_TOKEN is not configured");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not publish when cancelled during the synthetic run", async () => {
    const controller = new AbortController();
    mocks.progress.mockImplementation(async () => controller.abort());
    const { result } = await run(agent(INPUT, STANDIN_ENV), controller.signal);
    expect(result).toMatchObject({ status: "error", summary: "Run cancelled." });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("surfaces a mock GitHub publish failure as an error, never as success", async () => {
    mocks.publish.mockRejectedValue(new Error("mock github down"));
    const { result } = await run(agent(INPUT, STANDIN_ENV));
    expect(result).toMatchObject({ status: "error", summary: "mock github down" });
  });

  it("uses the real runtime when the flag is absent", async () => {
    mocks.run.mockResolvedValue({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "real",
    });
    const { result } = await run(agent({ ...INPUT, publishPullRequest: false }, { GITHUB_TOKEN: "t" }));
    expect(result.summary).toBe("real");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
