import { readUIMessageStream, type UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgent, createSandboxOps } from "../src/agents/opencode-agent.js";
import { sealChildDispatch } from "../src/child-dispatch.js";
import { formatAgentToolInput, parseAgentResultText, type CodingTaskInput, type CodingTaskResult } from "../src/opencode-input.js";

const DISPATCH_KEY = "fe".repeat(32);

const mocks = vi.hoisted(() => ({
  run: vi.fn(), publish: vi.fn(), sandbox: vi.fn(), progress: vi.fn(), decodeFile: vi.fn(), launch: vi.fn(),
}));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("../src/sandbox/client.js", () => ({ getSandbox: mocks.sandbox }));
import { resetSandboxProviderCache } from "../src/sandbox/provider.js";
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: mocks.launch } }));
vi.mock("../src/runtime.js", () => ({
  createRuntimeAdapter: () => ({ runCodingTask: mocks.run }),
  resolveRuntimeName: (name?: string) => name ?? "sandbox",
}));
vi.mock("../src/github.js", () => ({ publishFilesAsPullRequest: mocks.publish }));

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo", task: "Fix it.", baseBranch: "main",
  publishPullRequest: false, sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};
let sealedInput: CodingTaskInput = INPUT;

async function sealed(overrides: Partial<CodingTaskInput> = {}): Promise<CodingTaskInput> {
  const base = { ...INPUT, ...overrides };
  return {
    ...base,
    ...(await sealChildDispatch({ MODEL_CREDENTIAL_KEY: DISPATCH_KEY }, {
      approvalId: "agent-tool:test",
      sandboxId: base.sandboxId,
      inputHash: "a".repeat(64),
    })),
  };
}

const RESULT: CodingTaskResult = {
  status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["a.ts"],
  diff: "+fixed", files: [{ path: "a.ts", content: "complete file", encoding: "utf8" }], summary: "Done.",
};

function agent(input = sealedInput, token?: string) {
  return Object.assign(Object.create(OpenCodeAgent.prototype) as OpenCodeAgent, {
    env: { GITHUB_TOKEN: token, MODEL_CREDENTIAL_KEY: DISPATCH_KEY },
    messages: [{ id: "input", role: "user", parts: [{ type: "text", text: formatAgentToolInput(input) }] }],
    reportProgress: mocks.progress,
  });
}

async function responseFor(instance: OpenCodeAgent, signal?: AbortSignal) {
  const response = await instance.onChatMessage(() => {}, { requestId: "test", abortSignal: signal });
  expect(response?.headers.get("content-type")).toContain("text/event-stream");
  const chunks = (await response!.text()).split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk);
  const text = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("");
  return { chunks, text, result: parseAgentResultText(text) };
}

beforeEach(async () => {
  vi.resetAllMocks();
  resetSandboxProviderCache();
  mocks.sandbox.mockReturnValue({});
  mocks.run.mockResolvedValue(RESULT);
  mocks.publish.mockResolvedValue({ pullUrl: "https://github.com/owner/repo/pull/1" });
  sealedInput = await sealed();
});

describe("requested deliverable private persistence", () => {
  it("runs an artifact-workspace target without a repository and retains its requested output", async () => {
    const executionTarget = {
      kind: "artifact-workspace" as const,
      workspaceName: "Sales workspace",
      expectedDeliverables: ["sales/account-brief.md"],
    };
    const content = "# Account brief\nSynthetic fixture only.\n";
    const instance = agent(await sealed({
      repoUrl: "",
      publishPullRequest: false,
      executionTarget,
      expectedDeliverables: executionTarget.expectedDeliverables,
    }));
    const put = vi.fn(async (_key: string, _body: string, _options: unknown) => ({ key: "stored" }));
    Object.assign(instance.env, { ATTACHMENTS: { put } });
    mocks.run.mockImplementation(async (_ops, input) => {
      expect(input.repoUrl).toBe("");
      expect(input.executionTarget).toEqual(executionTarget);
      return {
        ...RESULT,
        changedFiles: ["sales/account-brief.md"],
        files: [{ path: "sales/account-brief.md", content, encoding: "utf8" }],
      };
    });

    const { result, text } = await responseFor(instance);

    expect(result.status).toBe("completed");
    expect(result.deliverables).toEqual([{
      path: "sales/account-brief.md",
      bytes: content.length,
      mediaType: "text/markdown; charset=utf-8",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[1]).toBe(content);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(text).not.toContain(content);
  });

  it("stores only requested complete files and returns metadata without bodies in the assistant result", async () => {
    const instance = agent(await sealed({ publishPullRequest: false, expectedDeliverables: ["reports/brief.md"] }));
    const put = vi.fn(async (_key: string, _body: string, _options: unknown) => ({ key: "stored" }));
    Object.assign(instance.env, { ATTACHMENTS: { put } });
    const content = "PRIVATE_REQUESTED_REPORT_BODY";
    mocks.run.mockResolvedValue({ ...RESULT, files: [
      { path: "reports/brief.md", content, encoding: "utf8" },
      { path: "private.txt", content: "UNREQUESTED_FILE_BODY", encoding: "utf8" },
    ] });
    const { result, text } = await responseFor(instance);
    expect(result.status).toBe("completed");
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[1]).toBe(content);
    expect(result.deliverables).toEqual([{ path: "reports/brief.md", bytes: content.length, mediaType: "text/markdown; charset=utf-8", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(result.files).toEqual([]);
    expect(text).not.toContain(content);
    expect(text).not.toContain("UNREQUESTED_FILE_BODY");
    expect(JSON.stringify(result)).not.toContain('"content"');
  });

  it.each(["missing", "storage-failure", "cancel-during-storage"])("does not expose a manifest after %s", async (failure) => {
    const instance = agent(await sealed({ publishPullRequest: false, expectedDeliverables: ["brief.md"] }));
    const controller = new AbortController();
    const put = vi.fn(async () => {
      if (failure === "cancel-during-storage") controller.abort();
      return failure === "storage-failure" ? null : { key: "stored" };
    });
    Object.assign(instance.env, { ATTACHMENTS: { put } });
    mocks.run.mockResolvedValue({ ...RESULT, files: failure === "missing" ? [] : [{ path: "brief.md", content: "complete draft", encoding: "utf8" }] });
    const { result } = await responseFor(instance, controller.signal);
    expect(result.status).toBe("error");
    expect(result.deliverables).toBeUndefined();
    expect(result.files).toEqual([]);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe("OpenCodeAgent response boundary", () => {
  it("returns a complete assistant stream the SDK can reconstruct without manual persistence", async () => {
    const { chunks, result } = await responseFor(agent());
    const messages = [];
    for await (const message of readUIMessageStream({ stream: new ReadableStream({
      start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); },
    }) })) messages.push(message);
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: expect.stringContaining("SHIBA_AI_COWORKER_CODING_RESULT_JSON"), state: "done" }]);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(result.files).toEqual([]);
  });

  it("bounds and redacts progress, rendered output, and result without exposing raw files", async () => {
    const token = "opaque-installation-credential";
    const secret = "ghp_1234567890abcdef";
    mocks.run.mockImplementation(async (_ops, _input, emit) => {
      for (let i = 0; i < 1000; i++) await emit({ phase: "code", message: `${secret} ${token} ${"x".repeat(5000)}`, fraction: 0.5 });
      return { ...RESULT, summary: `${secret} ${token}`, diff: `${"x".repeat(40_000)}${secret} ${token}`,
        stderrTail: secret, files: [{ path: "private", content: "RAW_FILE_MUST_NOT_LEAVE", encoding: "utf8" }] };
    });
    const { text, result } = await responseFor(agent(sealedInput, token));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token);
    expect(text).not.toContain("RAW_FILE_MUST_NOT_LEAVE");
    expect(text).toContain("[redacted]");
    expect(text.length).toBeLessThan(70_000);
    expect(result.diff.length).toBeLessThan(20_100);
    expect(result.files).toEqual([]);
    expect(mocks.progress.mock.calls.length).toBeLessThanOrEqual(100);
    for (const [event] of mocks.progress.mock.calls) {
      expect(event.message.length).toBeLessThan(2100);
      expect(event.message).not.toContain(secret);
      expect(event.message).not.toContain(token);
    }
  });

  it("passes original complete files and null deletions only to Worker publication", async () => {
    const files: CodingTaskResult["files"] = [
      { path: "secret.txt", content: "ghp_1234567890abcdef", encoding: "utf8" },
      { path: "gone.txt", content: null, encoding: "utf8" },
    ];
    mocks.run.mockResolvedValue({ ...RESULT, files });
    const signal = new AbortController().signal;
    const { text, result } = await responseFor(agent(await sealed({ publishPullRequest: true }), "token"), signal);
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ files });
    expect(result.files).toEqual([]);
    expect(text).not.toContain(files[0]!.content);
    expect(text).toContain("Pull request: https://github.com/owner/repo/pull/1");
  });

  it("forwards GITHUB_API_BASE to publication so a mock GitHub receives the PR write", async () => {
    const instance = agent(await sealed({ publishPullRequest: true }), "token");
    Object.assign(instance.env, { GITHUB_API_BASE: "http://127.0.0.1:4010" });
    await responseFor(instance);
    expect(mocks.publish).toHaveBeenCalledWith(expect.anything(), { apiBase: "http://127.0.0.1:4010" });
  });

  it("returns a structured safe failure when runtime throws", async () => {
    mocks.run.mockRejectedValue(new Error("Failed ghp_1234567890abcdef"));
    const { chunks, text, result } = await responseFor(agent());
    expect(result).toMatchObject({ status: "error", exitCode: -1, files: [], summary: "Failed [redacted]" });
    expect(text).not.toContain("ghp_1234567890abcdef");
    expect(chunks).toContainEqual({ type: "error", errorText: "Failed [redacted]" });
  });

  it("keeps process exit code and marks a returned runtime failure as an SDK error", async () => {
    mocks.run.mockResolvedValue({ ...RESULT, status: "error", exitCode: 7, summary: "OpenCode exited with code 7." });
    const { chunks, result } = await responseFor(agent());
    expect(result.exitCode).toBe(7);
    expect(chunks).toContainEqual({ type: "error", errorText: "OpenCode exited with code 7." });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("fails before sandbox creation for missing publication credentials", async () => {
    const { result } = await responseFor(agent(await sealed({ publishPullRequest: true })));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("GITHUB_TOKEN is not configured");
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });

  it("reports sandbox setup errors through the structured result", async () => {
    mocks.sandbox.mockImplementation(() => { throw new Error("Sandbox unavailable"); });
    mocks.run.mockImplementation(async (ops) => {
      await ops.gitCheckout("https://github.com/owner/repo", { branch: "main", targetDir: "/workspace/x" });
      return RESULT;
    });
    const { result } = await responseFor(agent());
    expect(result).toMatchObject({ status: "error", summary: "Sandbox unavailable" });
  });

  it("short-circuits a pre-aborted request before sandbox creation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await responseFor(agent(), controller.signal);
    expect(result).toMatchObject({ status: "error", summary: "Run cancelled." });
    expect(mocks.sandbox).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("propagates cancellation and prevents publishing after cancellation during coding", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async (_ops, _input, _emit, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return RESULT;
    });
    const { result } = await responseFor(agent(await sealed({ publishPullRequest: true }), "token"), controller.signal);
    expect(result.summary).toBe("Run cancelled.");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("keeps the tokenized preview URL out of the public PR body (T33 hardening)", async () => {
    // captureRunPreview is real here: the preview URL it mints served the
    // whole workdir, so the PR body must carry only the auth-gated screenshot
    // link, never the `{port}-{sandboxId}-{token}` URL itself.
    const previewUrl = `https://3000-${INPUT.sandboxId}-tok.shiba.example.com`;
    // Mirror the interception contract in captureRunPreview: the render page
    // enables request interception and registers a sync "request" listener
    // that resolves each intercepted request async (same-origin only).
    const requestHandlers: Array<(request: unknown) => void> = [];
    const page = {
      goto: vi.fn(async () => ({})),
      screenshot: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      setRequestInterception: vi.fn(async () => undefined),
      evaluateOnNewDocument: vi.fn(async () => undefined),
      on: vi.fn((_event: string, handler: (request: unknown) => void) => {
        requestHandlers.push(handler);
      }),
      click: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => ({})),
      evaluate: vi.fn(async () => "ok"),
    };
    mocks.launch.mockResolvedValue({ newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) });
    mocks.sandbox.mockReturnValue({
      exec: vi.fn(async () => ({ exitCode: 1, stdout: "" })),
      startProcess: vi.fn(async () => ({ waitForPort: vi.fn(async () => undefined), kill: vi.fn(async () => undefined) })),
      exposePort: vi.fn(async () => ({ url: previewUrl })),
      unexposePort: vi.fn(async () => undefined),
    });
    const publishInput = await sealed({ publishPullRequest: true });
    const instance = Object.assign(Object.create(OpenCodeAgent.prototype) as OpenCodeAgent, {
      env: {
        GITHUB_TOKEN: "token",
        MODEL_CREDENTIAL_KEY: DISPATCH_KEY,
        BROWSER: {},
        ATTACHMENTS: { put: vi.fn(async () => undefined) },
        WORKER_HOSTNAME: "shiba.example.com",
      },
      messages: [{ id: "input", role: "user", parts: [{ type: "text", text: formatAgentToolInput(publishInput) }] }],
      reportProgress: mocks.progress,
    });
    await responseFor(instance);
    const body = (mocks.publish.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain(`[Preview screenshot](https://shiba.example.com/api/screenshots/${INPUT.sandboxId})`);
    expect(body).not.toContain(previewUrl);
    expect(body).not.toMatch(/Preview:/);
    // The render page must intercept requests and register the same-origin
    // listener before navigation, so untrusted workdir HTML cannot exfiltrate.
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    expect(page.on).toHaveBeenCalledWith("request", expect.any(Function));
    expect(requestHandlers.length).toBeGreaterThanOrEqual(1);
    // The result envelope still carries both links for the internal run record.
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("writes the proof section into the PR body: test tail + honest preview state (T46)", async () => {
    // No BROWSER/ATTACHMENTS bindings → captureRunPreview fails safe to null:
    // the body must say so instead of implying a proof link that isn't there,
    // and must quote the real test output tail, not a summary of it.
    mocks.run.mockResolvedValue({
      ...RESULT,
      testEvidence: {
        command: "'pnpm' 'test'",
        exitCode: 0,
        outputTail: "Test Files  12 passed (12)\n Tests  96 passed",
      },
    });
    await responseFor(agent(await sealed({ publishPullRequest: true }), "token"));
    const body = (mocks.publish.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("**Test evidence:** `'pnpm' 'test'` → exit 0");
    expect(body).toContain("Tests  96 passed");
    expect(body).toContain("No preview captured");
    expect(body).not.toMatch(/\[Preview screenshot\]/);
  });

  it("reports a publication error instead of emitting coding success", async () => {
    mocks.publish.mockRejectedValue(new Error("GitHub unavailable"));
    const { result, text } = await responseFor(agent(await sealed({ publishPullRequest: true }), "token"));
    expect(result.status).toBe("error");
    expect(result.summary).toBe("GitHub unavailable");
    expect(text).not.toContain("Pull request:");
  });
});

describe("createSandboxOps", () => {
  it.each([
    { chunks: ["hello ", "world"], expected: { kind: "utf8", content: "hello world" } },
    { chunks: [new Uint8Array([0, 255, 1])], expected: { kind: "base64", content: "AP8B" } },
  ])("collects raw file bytes from the sandbox Files API", async ({ chunks, expected }) => {
    const parts = chunks.map((c) => (typeof c === "string" ? new TextEncoder().encode(c) : c));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    mocks.sandbox.mockReturnValue({ readFileStream: vi.fn().mockResolvedValue(stream) });
    expect(await createSandboxOps({} as never, INPUT.sandboxId).readFile("a.txt")).toEqual(expected);
  });

  it("rejects oversized decoded files rather than publishing a truncated file", async () => {
    const big = new TextEncoder().encode("x".repeat(500_001));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    mocks.sandbox.mockReturnValue({ readFileStream: vi.fn().mockResolvedValue(stream) });
    await expect(createSandboxOps({} as never, INPUT.sandboxId).readFile("large.txt")).rejects.toThrow("limit");
  });

  it("scopes the GitHub credential to the run's repo before cloning (B6)", async () => {
    const calls: string[] = [];
    const approveRepoScope = vi.fn(async () => { calls.push("approve"); });
    const gitCheckout = vi.fn(async () => { calls.push("clone"); });
    mocks.sandbox.mockReturnValue({ approveRepoScope, gitCheckout });
    await createSandboxOps({} as never, INPUT.sandboxId)
      .gitCheckout("https://github.com/owner/repo", { branch: "main", targetDir: "/workspace" });
    expect(approveRepoScope).toHaveBeenCalledWith("/owner/repo");
    // Scoping must precede the clone, or the clone itself runs unscoped.
    expect(calls).toEqual(["approve", "clone"]);
  });

  it("narrows egress to the selected harness's hosts before cloning (T22)", async () => {
    const calls: string[] = [];
    const approveHarnessEgress = vi.fn(async () => { calls.push("egress"); });
    const approveRepoScope = vi.fn(async () => { calls.push("scope"); });
    const gitCheckout = vi.fn(async () => { calls.push("clone"); });
    mocks.sandbox.mockReturnValue({ approveHarnessEgress, approveRepoScope, gitCheckout });
    await createSandboxOps({} as never, INPUT.sandboxId, ["api.anthropic.com", "github.com"])
      .gitCheckout("https://github.com/owner/repo", { branch: "main", targetDir: "/workspace" });
    expect(approveHarnessEgress).toHaveBeenCalledWith(["api.anthropic.com", "github.com"]);
    expect(calls).toEqual(["egress", "scope", "clone"]);
  });

  it("refuses to clone a non-GitHub repo rather than scoping nothing", async () => {
    const approveRepoScope = vi.fn();
    const gitCheckout = vi.fn();
    mocks.sandbox.mockReturnValue({ approveRepoScope, gitCheckout });
    await expect(
      createSandboxOps({} as never, INPUT.sandboxId)
        .gitCheckout("https://evil.example.com/owner/repo", { branch: "main", targetDir: "/workspace" }),
    ).rejects.toThrow();
    expect(gitCheckout).not.toHaveBeenCalled();
  });

  it("does not cross the RPC boundary with AbortSignal but aborts locally", async () => {
    const controller = new AbortController();
    const exec = vi.fn().mockResolvedValue({ stdout: "out", stderr: "err", exitCode: 4 });
    mocks.sandbox.mockReturnValue({ exec });
    const ops = createSandboxOps({} as never, INPUT.sandboxId);
    expect(await ops.exec("command", { cwd: "/workspace", timeoutMs: 100, signal: controller.signal })).toEqual({ stdout: "out", stderr: "err", exitCode: 4 });
    // AbortSignal is not RPC-serializable; the stub must never see it. The
    // remote process is bounded by timeout and abort is raced in locally.
    expect(exec).toHaveBeenCalledWith("command", expect.not.objectContaining({ signal: expect.anything() }));
    await expect(ops.exec("command", { signal: AbortSignal.abort() })).rejects.toThrow(/abort/i);
    exec.mockReturnValue(new Promise(() => {}));
    const midFlight = new AbortController();
    const pending = ops.exec("command", { signal: midFlight.signal });
    midFlight.abort();
    await expect(pending).rejects.toThrow("Run cancelled.");
  });
});
