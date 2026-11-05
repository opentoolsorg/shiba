import { describe, expect, it } from "vitest";
import { HARNESSES } from "../src/harness/index.js";
import type { AgentHarnessName, HarnessEvent } from "../src/harness/types.js";
import { runEnvScrubber } from "../src/run-env-seal.js";

const SECRET = 'private-"quote\\slash\ncredential-tail-987654321';
const scrub = runEnvScrubber({ APP_SECRET: SECRET });
function harnessFor(name: AgentHarnessName) {
  const harness = HARNESSES[name];
  if (!harness) throw new Error("Fixture harness is unavailable.");
  return harness;
}

const crossing = `${"x".repeat(490)}${SECRET}${"y".repeat(490)}`;

type Shape = "opencode" | "claude" | "codex" | "grok" | "pi" | "flat";
const harnesses: Array<[AgentHarnessName, Shape]> = [
  ["opencode", "opencode"], ["claude-code", "claude"], ["codex", "codex"], ["grok", "grok"],
  ["pi", "pi"], ["cursor", "flat"], ["antigravity", "flat"], ["claude-subscription", "claude"],
  ["codex-subscription", "codex"], ["claude-login", "claude"], ["cursor-subscription", "flat"],
  ["antigravity-subscription", "flat"], ["claude-acp", "flat"], ["codex-acp", "flat"], ["acp", "flat"],
  ["gemini-acp", "flat"], ["opencode-acp", "flat"],
];

function textLine(shape: Shape, text: string): string {
  const record = shape === "opencode" ? { type: "text", part: text }
    : shape === "claude" ? { type: "assistant", message: { content: [{ type: "text", text }] } }
    : shape === "grok" ? { type: "text", data: text }
    : shape === "pi" ? { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }
    : { type: "text", text };
  return JSON.stringify(record);
}

function errorLine(shape: Shape, text: string): string {
  return JSON.stringify(shape === "claude" ? { type: "result", is_error: true, result: text }
    : shape === "pi" ? { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: text } }
    : { type: "error", message: text });
}

function noSecret(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(JSON.stringify(SECRET).slice(1, -1));
  expect(serialized).not.toContain("credential-tail-987654321");
  expect(serialized).not.toContain("987654321");
}

describe("protocol-preserving harness sanitization", () => {
  it.each(harnesses)("%s scrubs decoded display strings before bounds, including escaped and multiline values", (name, shape) => {
    const event = harnessFor(name).parseEvent(textLine(shape, crossing), scrub);
    expect(event).not.toBeNull();
    if (!event) throw new Error("Expected a display event.");
    expect(event.text.length).toBeLessThanOrEqual(550);
    noSecret(event);
  });

  it.each(harnesses)("%s sanitizes whitespace-bearing values before trimming display content", (name, shape) => {
    const padded = `  ${SECRET}  `;
    const event = harnessFor(name).parseEvent(textLine(shape, padded), runEnvScrubber({ APP_SECRET: padded }));
    expect(event).not.toBeNull(); noSecret(event);
  });

  it.each(harnesses)("%s still throws sanitized native errors without partial secret tails", (name, shape) => {
    let error: unknown;
    try { harnessFor(name).parseEvent(errorLine(shape, crossing), scrub); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    noSecret((error as Error).message);
    expect((error as Error).message.length).toBeLessThanOrEqual(600);
  });

  it.each(harnesses.filter(([name]) => !name.startsWith("antigravity")))("%s malformed protocol errors omit raw snippets", (name) => {
    let error: unknown;
    try { harnessFor(name).parseEvent(`{"type":"broken","text":"${crossing}`, scrub); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Unparseable/);
    noSecret((error as Error).message);
    expect((error as Error).message).not.toContain("xxxx");
  });

  it.each(["antigravity", "antigravity-subscription"] as const)("%s sanitizes its supported plaintext fallback before bounding", (name) => {
    const escaped = JSON.stringify(crossing).slice(1, -1);
    const event = harnessFor(name).parseEvent(`not-json ${escaped}`, scrub);
    expect(event?.kind).toBe("text"); noSecret(event);
  });

  it("keeps Codex cumulative usage when an approved value matches the completion protocol", () => {
    const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
    const sanitizer = runEnvScrubber({ APP_STATE: "completed" });
    for (const name of ["codex", "codex-subscription"] as const) {
      expect(harnessFor(name).parseEvent(line, sanitizer)).toMatchObject({ kind: "usage", cumulative: true, usage: { inputTokens: 7, outputTokens: 3 } });
    }
  });

  it("keeps OpenCode and Claude usage classification while scrubbing display content", () => {
    const sanitizer = runEnvScrubber({ APP_STATE: "step_finish", APP_ROLE: "assistant", APP_SECRET: SECRET });
    expect(harnessFor("opencode").parseEvent(JSON.stringify({ type: "step_finish", part: { tokens: { input: 7, output: 3 } } }), sanitizer))
      .toMatchObject({ kind: "usage", usage: { inputTokens: 7, outputTokens: 3 } });
    const event = harnessFor("claude-code").parseEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: crossing }], usage: { input_tokens: 7, output_tokens: 3 } } }), sanitizer);
    expect(event).toMatchObject({ kind: "usage", cumulative: false, usage: { inputTokens: 7, outputTokens: 3 } });
    noSecret(event);
  });

  it.each(["codex", "claude-code", "codex-subscription", "claude-subscription", "claude-login"] as const)("%s classifies session envelopes before sanitizing their text", (name) => {
    const sanitizer = runEnvScrubber({ APP_STATE: "completed", APP_SECRET: SECRET });
    const event = harnessFor(name).parseEvent(JSON.stringify({ type: "shiba.event", event: { type: "turn.completed" }, text: crossing }), sanitizer);
    expect(event?.kind).toBe("result"); noSecret(event);
  });

  it.each(["codex-subscription", "claude-subscription", "antigravity-subscription"] as const)("%s preserves limit error classification even when its message is fully redacted", (name) => {
    const selected = harnesses.find(([entry]) => entry === name);
    if (!selected) throw new Error("Expected a fixture shape.");
    const shape = selected[1];
    const sanitizer = runEnvScrubber({ APP_SECRET: "quota exceeded" });
    let error: unknown;
    try { harnessFor(name).parseEvent(errorLine(shape, "quota exceeded"), sanitizer); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toMatch(/UsageLimitError/);
    expect((error as Error).message).not.toContain("quota exceeded");
  });

  it("sanitizes tool names and subscription thread labels before truncation", () => {
    const tool: HarnessEvent | null = harnessFor("pi").parseEvent(JSON.stringify({ type: "tool_execution_start", toolName: crossing }), scrub);
    expect(tool?.kind).toBe("tool"); noSecret(tool);
    const session = harnessFor("codex").parseEvent(JSON.stringify({ type: "shiba.event", event: { type: "tool.started", name: crossing }, text: crossing }), scrub);
    expect(session?.kind).toBe("tool"); noSecret(session);
    const thread = harnessFor("codex-subscription").parseEvent(JSON.stringify({ type: "thread", threadId: crossing }), scrub);
    noSecret(thread);
  });
});
