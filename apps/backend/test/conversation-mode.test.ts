import { describe, expect, it } from "vitest";
import { isAppToolsOnlyTurn, isChatOnlyTurn, toolsForConversationMode } from "../src/conversation-mode.js";

describe("conversation mode tool boundary", () => {
  it("recognizes only the latest user's app-tools target, including alongside a narrowing Chat marker", () => {
    expect(isAppToolsOnlyTurn([{ role: "user", metadata: { shibaMode: "work", shibaWorkTarget: "app-tools" } }])).toBe(true);
    expect(isAppToolsOnlyTurn([{ role: "user", metadata: { shibaMode: "chat", shibaWorkTarget: "app-tools" } }])).toBe(true);
    expect(isAppToolsOnlyTurn([{ role: "user", metadata: { shibaWorkTarget: "app-tools" } }, { role: "user", metadata: { shibaMode: "work" } }])).toBe(false);
    expect(isAppToolsOnlyTurn([{ role: "assistant", metadata: { shibaWorkTarget: "app-tools" } }])).toBe(false);
    expect(isAppToolsOnlyTurn(undefined)).toBe(false);
  });
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
