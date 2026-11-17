import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiBlock } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleSlackInteract } from "../src/slack-approval.js";
import { renderUiBlockToSlack } from "../src/slack-ui-blocks.js";
import { createUiBlock, getUiBlock } from "../src/ui-block-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const runId = "slack:T1:C1:123.000001";
const secret = "slack-ui-test-secret";
const ownerId = "owner@example.test";
const blocks: UiBlock[] = [
  { version: 1, id: "confirm_task", type: "confirm", prompt: "Delete files?", confirmLabel: "Delete", cancelLabel: "Cancel", danger: true },
  { version: 1, id: "reply", type: "quick_replies", prompt: "Next step?", options: [{ id: "continue", label: "Continue" }, { id: "delete", label: "Delete", danger: true }] },
  { version: 1, id: "single", type: "choice", prompt: "Choose one", options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }] },
  { version: 1, id: "many", type: "choice", prompt: "Choose several", multiple: true, options: [{ id: "first", label: "First" }, { id: "second", label: "Second", danger: true }] },
  { version: 1, id: "form", type: "form", prompt: "Your details", fields: [{ id: "name", kind: "text", label: "Name", required: true }], submitLabel: "Submit" },
  { version: 1, id: "select", type: "choice", prompt: "Choose one of six", options: Array.from({ length: 6 }, (_, i) => ({ id: `option_${i}`, label: `Option ${i}`, danger: i === 5 })) },
];

async function request(payload: unknown, signed = true) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://example.test/api/slack/interact", { method: "POST", body,
    headers: signed ? { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${hex}` } : {},
  });
}

const payload = (block: UiBlock, optionId: string, confirmed = false) => ({
  type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, message: { thread_ts: "123.000001" },
  response_url: "https://hooks.slack.com/actions/test",
  actions: [{ action_id: `ui_block:button:${optionId}`, value: JSON.stringify({ runId, blockId: block.id, optionId, ...(confirmed ? { confirmed: true } : {}) }) }],
});

afterEach(() => vi.restoreAllMocks());

describe("Slack UI renderer", () => {
  for (const block of blocks) it(`renders ${block.id}`, () => {
    expect(renderUiBlockToSlack(block, { runId })).toMatchSnapshot();
  });
  it("keeps full fallback text and bounds action pointers", () => {
    const rendered = renderUiBlockToSlack(blocks[1]!, { runId });
    expect(rendered.text).toContain("Reply with the number(s)");
    expect(rendered.text).toContain("(destructive)");
    expect(() => renderUiBlockToSlack(blocks[1]!, { runId: "a".repeat(2000) })).toThrow("2000");
  });
});

describe("signed Slack UI answers", () => {
  async function setup(block: UiBlock, test: (env: Env) => Promise<void>) {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0061_ui_block_questions.sql", import.meta.url), "utf8"));
      const env = { AGENT_AUDIT: database, CHAT_EMPLOYEE_ACTOR: ownerId, SLACK_SIGNING_SECRET: secret, SLACK_APPROVERS: "U1" } as unknown as Env;
      await createUiBlock(env, ownerId, runId, block);
      await test(env);
    } finally { sqlite.close(); }
  }

  it("answers the store, replaces the card, and never dispatches approvals", async () => {
    await setup(blocks[1]!, async (env) => {
      const dispatchApprove = vi.fn();
      const doFetch = vi.fn();
      const replaceCard = vi.fn(async () => {});
      const response = await handleSlackInteract(await request(payload(blocks[1]!, "continue")), env, { dispatchApprove, orchestratorStub: { fetch: doFetch }, replaceCard });
      expect(response?.status).toBe(200);
      expect(await getUiBlock(env, ownerId, runId, "reply")).toMatchObject({ status: "answered", answeredVia: "slack", answer: { optionIds: ["continue"] } });
      expect(replaceCard).toHaveBeenCalledWith("https://hooks.slack.com/actions/test", expect.objectContaining({ text: "Answered: Continue.", replace_original: true }));
      expect(dispatchApprove).not.toHaveBeenCalled();
      expect(doFetch).not.toHaveBeenCalled();
    });
  });

  it.each([0, 1])("rejects a destructive answer without the confirmation dialog marker (%i)", async (index) => {
    const block = blocks[index]!;
    await setup(block, async (env) => {
      const respond = vi.fn(async () => {});
      const replaceCard = vi.fn(async () => {});
      await handleSlackInteract(await request(payload(block, index === 0 ? "yes" : "delete")), env, { respond, replaceCard });
      expect(respond).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("danger_requires_confirm"));
      expect((await getUiBlock(env, ownerId, runId, block.id))?.status).toBe("pending");
      expect(replaceCard).not.toHaveBeenCalled();
      await handleSlackInteract(await request(payload(block, index === 0 ? "yes" : "delete", true)), env, { respond, replaceCard });
      expect((await getUiBlock(env, ownerId, runId, block.id))?.status).toBe("answered");
    });
  });

  it("rejects unsigned, unallowlisted, wrong-thread, unknown-option, and replayed answers", async () => {
    await setup(blocks[1]!, async (env) => {
      const respond = vi.fn(async () => {});
      const replaceCard = vi.fn(async () => {});
      const deps = { respond, replaceCard };
      expect((await handleSlackInteract(await request(payload(blocks[1]!, "continue"), false), env, deps))?.status).toBe(401);
      const unauthorized = payload(blocks[1]!, "continue"); unauthorized.user.id = "OTHER";
      await handleSlackInteract(await request(unauthorized), env, deps);
      const wrongThread = payload(blocks[1]!, "continue"); wrongThread.channel.id = "OTHER";
      await handleSlackInteract(await request(wrongThread), env, deps);
      await handleSlackInteract(await request(payload(blocks[1]!, "unknown")), env, deps);
      expect((await getUiBlock(env, ownerId, runId, "reply"))?.status).toBe("pending");
      await handleSlackInteract(await request(payload(blocks[1]!, "continue")), env, deps);
      await handleSlackInteract(await request(payload(blocks[1]!, "continue")), env, deps);
      expect(replaceCard).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenLastCalledWith(expect.any(String), "Question is already resolved.");
    });
  });

  it("waits for submit, validates empty choices, then answers multiple selected options", async () => {
    const block = blocks[3]!;
    await setup(block, async (env) => {
      const respond = vi.fn(async () => {});
      const replaceCard = vi.fn(async () => {});
      const selection = payload(block, "submit", true);
      selection.actions = [{ action_id: "ui_block:selection", value: "" }];
      await handleSlackInteract(await request(selection), env, { respond, replaceCard });
      expect((await getUiBlock(env, ownerId, runId, block.id))?.status).toBe("pending");
      await handleSlackInteract(await request(payload(block, "submit", true)), env, { respond, replaceCard });
      expect((await getUiBlock(env, ownerId, runId, block.id))?.status).toBe("pending");
      const submit = { ...payload(block, "submit", true), state: { values: { "ui_block:many:0": { "ui_block:selection": { selected_options: ["first", "second"].map((optionId) => ({ value: JSON.stringify({ runId, blockId: block.id, optionId }) })) } } } } };
      await handleSlackInteract(await request(submit), env, { respond, replaceCard });
      expect((await getUiBlock(env, ownerId, runId, block.id))?.answer?.optionIds).toEqual(["first", "second"]);
    });
  });
});
