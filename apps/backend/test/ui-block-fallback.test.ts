import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { tryAnswerUiBlockFallback } from "../src/ui-block-fallback.js";
import { uiBlockRunId } from "../src/ui-block-scope.js";
import { createUiBlock, getUiBlock } from "../src/ui-block-store.js";
import { handleSlackEvent } from "../src/slack-mention.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const block = { version: 1, id: "question", type: "quick_replies", prompt: "Next?", options: [{ id: "keep", label: "Keep" }, { id: "delete", label: "Delete", danger: true }] };
describe("inbound fallback answers", () => {
  it("preserves separate fields in a multiline Slack form reply", async () => {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0068_ui_block_questions.sql", import.meta.url), "utf8"));
      const env = { AGENT_AUDIT: database, CHAT_EMPLOYEE_ACTOR: "owner", SLACK_APPROVERS: "U1" } as unknown as Env;
      const runId = uiBlockRunId("slack:T1:C1:123.000001", "form-task");
      await createUiBlock(env, "owner", runId, { version: 1, id: "details", type: "form", prompt: "Provide details", submitLabel: "Submit", fields: [
        { id: "name", label: "Name", kind: "text", required: true },
        { id: "reason", label: "Reason", kind: "textarea", required: true },
      ] });
      const bufferMessage = vi.fn();
      const queueRun = vi.fn();
      const postMessage = vi.fn(async () => {});
      await handleSlackEvent({ team_id: "T1", event_id: "form-answer", event: { type: "message", channel: "C1", user: "U1", thread_ts: "123.000001", ts: "123.000002", text: "<@BOT> Name: Ada\nReason: Fix the issue" } } as never, env, { bufferMessage, queueRun, postMessage });
      expect(await getUiBlock(env, "owner", runId, "details")).toMatchObject({ status: "answered", answeredVia: "fallback", answer: { values: { name: "Ada", reason: "Fix the issue" } } });
      expect(bufferMessage).not.toHaveBeenCalled();
      expect(queueRun).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });
  it.each(["slack:T1:C1:123.000001", "telegram:12345", "discord:4815162342"])("validates authorization, parsing, and current task for %s", async (threadId) => {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0068_ui_block_questions.sql", import.meta.url), "utf8"));
      const env = { AGENT_AUDIT: database, CHAT_EMPLOYEE_ACTOR: "owner", SLACK_APPROVERS: "U1", TELEGRAM_APPROVERS: "U1", DISCORD_APPROVERS: "U1" } as unknown as Env;
      const runId = uiBlockRunId(threadId, "task");
      expect(await tryAnswerUiBlockFallback(env, threadId, "U1", "1")).toBe(false);
      await createUiBlock(env, "owner", runId, block);
      for (const [user, text] of [["OTHER", "1"], ["U1", "not an answer"], ["U1", "2"]]) {
        expect(await tryAnswerUiBlockFallback(env, threadId, user!, text!)).toBe(false);
      }
      expect((await getUiBlock(env, "owner", runId, block.id))?.status).toBe("pending");
      expect(await tryAnswerUiBlockFallback(env, threadId, "U1", "2 confirm")).toBe(true);
      expect(await getUiBlock(env, "owner", runId, block.id)).toMatchObject({ status: "answered", answeredVia: "fallback", answer: { confirmed: true, optionIds: ["delete"] } });
      expect(await tryAnswerUiBlockFallback(env, threadId, "U1", "1")).toBe(false);
    } finally { sqlite.close(); }
  });

  it("consumes a Slack reply before buffering or queueing a new instruction", async () => {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0068_ui_block_questions.sql", import.meta.url), "utf8"));
      const env = { AGENT_AUDIT: database, CHAT_EMPLOYEE_ACTOR: "owner", SLACK_APPROVERS: "U1" } as unknown as Env;
      const runId = uiBlockRunId("slack:T1:C1:123.000001", "task");
      await createUiBlock(env, "owner", runId, block);
      const bufferMessage = vi.fn();
      const queueRun = vi.fn();
      const postMessage = vi.fn(async () => {});
      await handleSlackEvent({ team_id: "T1", event_id: "answer", event: { type: "message", channel: "C1", user: "U1", thread_ts: "123.000001", ts: "123.000002", text: "1" } } as never, env, { bufferMessage, queueRun, postMessage });
      expect((await getUiBlock(env, "owner", runId, block.id))?.answeredVia).toBe("fallback");
      expect(bufferMessage).not.toHaveBeenCalled();
      expect(queueRun).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });
});
