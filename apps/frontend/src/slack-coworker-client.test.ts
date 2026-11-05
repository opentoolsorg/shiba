import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackCoworkerClient } from "./slack-coworker-client";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const state = { bindings: [], challenges: [], grants: [], executionAvailable: false };
const workspaceId = `ws_${"a".repeat(24)}`;

describe("Slack coworker client fetch receiver", () => {
  it("uses the global receiver for native fetch and retains injection", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    async function receiverChecked(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const path = String(input); calls.push({ path, init });
      return Response.json(path.endsWith("/drafts") ? { drafts: [] } : state);
    }
    vi.stubGlobal("fetch", receiverChecked);
    const defaultClient = new SlackCoworkerClient(workspaceId, "member@example.test");
    await expect(defaultClient.read(new AbortController().signal)).resolves.toEqual({ state, drafts: [] });
    const injectedClient = new SlackCoworkerClient(workspaceId, "member@example.test", receiverChecked);
    await expect(injectedClient.read(new AbortController().signal)).resolves.toEqual({ state, drafts: [] });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  });
});
