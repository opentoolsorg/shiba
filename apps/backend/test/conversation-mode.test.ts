import { describe, expect, it } from "vitest";
import { isChatOnlyTurn, toolsForConversationMode } from "../src/conversation-mode.js";

describe("conversation mode tool boundary", () => {
  it("restricts only when the latest user turn explicitly selects Chat", () => {
    expect(isChatOnlyTurn([{ role: "user", metadata: { shibaMode: "chat" } }])).toBe(true);
    expect(isChatOnlyTurn([
      { role: "user", metadata: { shibaMode: "chat" } },
      { role: "assistant", parts: [] },
      { role: "user", metadata: { shibaMode: "work" } },
    ])).toBe(false);
    expect(isChatOnlyTurn([{ role: "user", metadata: { shibaMode: "not-a-mode" } }])).toBe(false);
    expect(isChatOnlyTurn(undefined)).toBe(false);
  });

  it("removes every registered tool in Chat and keeps Work tools intact", () => {
    const tools = { delegate_coding_task: () => {}, run_code: () => {} };
    expect(toolsForConversationMode("chat", tools)).toEqual({});
    expect(toolsForConversationMode("work", tools)).toBe(tools);
  });
});
