import { describe, expect, it } from "vitest";
import { memoryScopeForConversation } from "../src/memory-scope.js";

const SESSION = "12345678-1234-1234-1234-123456789abc";

describe("server-derived conversation memory scope", () => {
  it("shares learned facts only across an authenticated owner's own dashboard sessions", () => {
    expect(memoryScopeForConversation("Alice@example.test")).toBe("Alice@example.test");
    expect(memoryScopeForConversation(`web:Alice@example.test:${SESSION}`)).toBe("Alice@example.test");
    expect(memoryScopeForConversation(`web:bob@example.test:${SESSION}`)).toBe("bob@example.test");
  });

  it("keeps Slack workspace, channel and thread boundaries distinct", () => {
    const names = ["slack:T1:C1:123.000001", "slack:T1:C2:123.000001", "slack:T2:C1:123.000001", "slack:T1:C1:123.000002"];
    expect(names.map(memoryScopeForConversation)).toEqual(names);
    expect(new Set(names.map(memoryScopeForConversation)).size).toBe(4);
  });

  it.each([undefined, "", "default", "global", "orchestrator-agent", "orchestrator", "system", "admin", "automation", " default ",
    "slack:T1:C1:invalid", "slack:T1:C1:123.4:extra", "slack:T1:C1:123.4\n", "slack:T1:C1:123", "captain:daily", "telegram:1:2",
    "web:alice:default", "web:alice:not-a-uuid", `web:global:${SESSION}`, "a".repeat(513)])("fails closed for ambiguous or malformed name %j", (name) => {
    expect(memoryScopeForConversation(name)).toBeNull();
  });
});
