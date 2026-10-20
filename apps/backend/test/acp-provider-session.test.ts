import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpAdapterPlan } from "../src/acp-providers.js";
import { acpDriverPath } from "../src/harness/acp.js";
import { resolveHarness } from "../src/harness/index.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const MOCK_AGENT = `const fs = require("node:fs");
const side = process.argv[2];
let buf = "";
const waiters = [];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function onLine(line) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-acp-test" } });
    return;
  }
  if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const text = msg.params.prompt[0].text;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "adapter-ok" } } },
    });
    send({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        options: [
          { optionId: "allow-always", kind: "allow_always" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
      },
    });
    waiters.push((response) => {
      fs.writeFileSync(side, JSON.stringify({ text, optionId: response.result.outcome.optionId }));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    return;
  }
  if (msg.id === 99 && msg.result) {
    const done = waiters.shift();
    if (done) done(msg);
  }
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let index;
  while ((index = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    if (line.trim()) onLine(line);
  }
});
`;

describe("ACP adapter session", () => {
  it("runs a task through the Claude ACP driver against a mock JSON-RPC agent", () => {
    const plan = acpAdapterPlan("claude");
    const input: CodingTaskInput = {
      repoUrl: "https://github.com/owner/repo",
      task: "ACP-TASK-MARKER",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "run-acp-session",
      codingModel: plan.model,
    };
    const harness = resolveHarness(plan.harness);
    const config = harness.configFile(input, input.sandboxId);
    const files = Array.isArray(config) ? config : config === null ? [] : [config];
    const driver = files.find((file) => file.path === acpDriverPath(input.sandboxId));
    if (driver === undefined) throw new Error("ACP driver file was not emitted");
    expect(driver.contents).toContain('"claude-agent-acp"');
    expect(plan.spawn).toEqual(["claude-agent-acp"]);

    const dir = mkdtempSync(join(tmpdir(), "acp-session-"));
    const mockPath = join(dir, "mock-acp.cjs");
    const sidePath = join(dir, "side.json");
    const driverPath = join(dir, "driver.cjs");
    writeFileSync(mockPath, MOCK_AGENT);
    const contents = driver.contents.replace(
      '"argv":["claude-agent-acp"]',
      `"argv":${JSON.stringify([process.execPath, mockPath, sidePath])}`,
    );
    expect(contents).not.toContain('"argv":["claude-agent-acp"]');
    writeFileSync(driverPath, contents);

    const stdout = execFileSync(process.execPath, [driverPath], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const side = JSON.parse(readFileSync(sidePath, "utf8")) as { text: string; optionId: string };
    expect(side.text).toBe("ACP-TASK-MARKER");
    expect(side.optionId).toBe("allow-once");
    expect(stdout).toContain("adapter-ok");
    expect(stdout).toContain("stopReason: end_turn");
  });
});
