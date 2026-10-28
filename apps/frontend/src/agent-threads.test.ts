import { afterEach, describe, expect, it, vi } from "vitest";
import { agentThreads, applyThreadRename, createAgentThread, loadThreadMessages, threadAgentId } from "./agent-threads";
import type { CustomAgentWire } from "./components/CustomAgentsView";

afterEach(() => vi.unstubAllGlobals());
const agent: CustomAgentWire = {
  id: "agent-reviewer", slug: "reviewer", version: 1,
  config: { name: "Reviewer", instructions: "Review carefully", harness: "codex" },
};

describe("custom agent threads", () => {
  it("creates a fresh named thread with persisted agent metadata and no execution request", async () => {
    const session = { id: "new-thread", name: "Reviewer", agentName: "web:user:new-thread", updatedAt: 1, metadata: { customAgentId: agent.id } };
    const request = vi.fn().mockResolvedValue(Response.json({ session }));
    vi.stubGlobal("fetch", request);
    expect(await createAgentThread(agent)).toEqual(session);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "Reviewer", metadata: { customAgentId: agent.id } }),
    }));
    expect(threadAgentId(session)).toBe(agent.id);
  });

  it("refuses unsupported or unauthorized creation instead of reusing an existing thread", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 })));
    await expect(createAgentThread(agent)).rejects.toMatchObject({ message: "Unauthorized" });
  });

  it("rejects a success response pointing at the default session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ session: { id: "default", name: "Default", agentName: "user", updatedAt: 1 } })));
    await expect(createAgentThread(agent)).rejects.toMatchObject({ message: "The server did not return a new thread. Try again." });
  });

  it("rejects a created thread that lost its bot association", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ session: { id: "new-thread", name: "Reviewer", agentName: "web:user:new-thread", updatedAt: 1 } })));
    await expect(createAgentThread(agent)).rejects.toMatchObject({ message: "The server did not return a new thread. Try again." });
  });

  it("restores only string agent identifiers from thread metadata", () => {
    const base = { id: "a", name: "A", agentName: "web:user:a", updatedAt: 1 };
    expect(threadAgentId(undefined)).toBe("");
    expect(threadAgentId(base)).toBe("");
    expect(threadAgentId({ ...base, metadata: { customAgentId: { id: "other" } } })).toBe("");
  });

  it("ignores a delayed rename older than the current thread name", () => {
    const current = [{ id: "a", name: "Latest name", agentName: "web:user:a", updatedAt: 3 }];
    expect(applyThreadRename(current, { id: "a", name: "Stale name", updatedAt: 2 })).toEqual(current);
    expect(applyThreadRename(current, { id: "a", name: "New name", updatedAt: 4 })[0]?.name).toBe("New name");
    expect(applyThreadRename(current, { id: "b", name: "Unrelated", updatedAt: 4 })).toEqual(current);
  });

  it("lists a bot's actual named sessions by most recently updated, excluding the default", () => {
    const a = { id: "a", name: "First", agentName: "web:user:a", updatedAt: 1, metadata: { customAgentId: agent.id } };
    const b = { ...a, id: "b", name: "Latest", updatedAt: 3 };
    const base = { ...a, id: "default", updatedAt: 4 };
    expect(agentThreads([a, base, { ...a, id: "other-bot", metadata: { customAgentId: "other" } }, b], agent.id)).toEqual([b, a]);
  });
});

describe("persisted thread message history", () => {
  it("loads a named session history using its actual agent name", async () => {
    const messages = [{ id: "message-1", role: "user", parts: [{ type: "text", text: "Review authentication" }] }];
    const request = vi.fn().mockResolvedValue(Response.json(messages));
    vi.stubGlobal("fetch", request);
    const active = { current: "web:user:session-a" };
    expect(await loadThreadMessages("web:user:session-a", "http://worker/agents/coding-orchestrator/web:user:session-a", active)).toEqual(messages);
    expect(request).toHaveBeenCalledWith("http://worker/agents/coding-orchestrator/web:user:session-a/get-messages", { credentials: "include" });
  });

  it("does not fetch history from a stale socket or unresolved identity", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    expect(await loadThreadMessages("old-session", "http://worker/old", { current: "new-session" })).toEqual([]);
    expect(await loadThreadMessages("identity-pending", "http://worker/pending", { current: null })).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("discards history if the user switches threads while the request is pending", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; })));
    const active = { current: "session-a" };
    const result = loadThreadMessages("session-a", "http://worker/a", active);
    active.current = "session-b";
    complete(Response.json([{ id: "private-message-a", role: "user", parts: [] }]));
    expect(await result).toEqual([]);
  });

  it("treats malformed or denied history responses as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("<html>Sign in</html>"))
      .mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ messages: [] })));
    const active = { current: "a" };
    expect(await loadThreadMessages("a", "http://worker/a", active)).toEqual([]);
    expect(await loadThreadMessages("a", "http://worker/a", active)).toEqual([]);
    expect(await loadThreadMessages("a", "http://worker/a", active)).toEqual([]);
  });
});
