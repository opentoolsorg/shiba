import { describe, expect, it } from "vitest";
import { ChannelError, type ChannelErrorKind, type ChannelEvent, type ChannelMessageRef, type ChannelThreadRef, type ChatChannel } from "./types.js";

/** Fakes expose transport observations, while each adapter owns its wire fixtures. */
export interface ChatChannelContractFixture {
  channel: ChatChannel;
  thread: ChannelThreadRef;
  expectedMention: ChannelEvent;
  mentionRequest(): Promise<Request>;
  badSignatureRequest(): Promise<Request>;
  actionRequest(message: ChannelMessageRef, action: "approve" | "deny"): Promise<Request>;
  posts: { conversationId: string; threadId?: string; text: string }[];
  updates: { conversationId: string; messageId: string; text: string; buttonsRemoved: boolean }[];
  failPost(kind: ChannelErrorKind, outcomeKnown: boolean): void;
}

/** Every registered adapter should invoke this suite with isolated fakes per test. */
export function chatChannelContract(name: string, create: () => ChatChannelContractFixture): void {
  describe(`${name} ChatChannel contract`, () => {
    it("rejects bad signatures before parsing", async () => {
      const fixture = create();
      const request = await fixture.badSignatureRequest();
      await expect(fixture.channel.verify(request)).resolves.toBe(false);
      await expect(fixture.channel.parse(request)).rejects.toMatchObject({ kind: "invalid_request" });
    });

    it("normalizes a signed mention without consuming the request", async () => {
      const fixture = create();
      const request = await fixture.mentionRequest();
      await expect(fixture.channel.verify(request)).resolves.toBe(true);
      await expect(fixture.channel.parse(request)).resolves.toEqual([fixture.expectedMention]);
      expect(request.bodyUsed).toBe(false);
    });

    it("posts and updates one message in the same thread", async () => {
      const fixture = create();
      const message = await fixture.channel.postMessage({ thread: fixture.thread, text: "Working" });
      expect(message.thread).toEqual(fixture.thread);
      expect(message.id).not.toBe("");
      await fixture.channel.updateMessage({ message, text: "Done" });
      expect(fixture.posts).toEqual([{ conversationId: fixture.thread.conversationId, threadId: fixture.thread.threadId, text: "Working" }]);
      expect(fixture.updates).toMatchObject([{ conversationId: fixture.thread.conversationId, messageId: message.id, text: "Done" }]);
    });

    for (const action of ["approve", "deny"] as const) {
      it(`round-trips an ${action} pointer and resolves its presentation`, async () => {
        const fixture = create();
        const approval = { threadKey: `${fixture.thread.channel}:${fixture.thread.tenantId}:${fixture.thread.conversationId}:${fixture.thread.threadId}`, approvalId: "approval-1" };
        const message = await fixture.channel.postApprovalRequest({ thread: fixture.thread, ...approval, repoUrl: "https://github.com/example/repo", task: "Fix the test" });
        const request = await fixture.actionRequest(message, action);
        await expect(fixture.channel.parse(request)).resolves.toEqual([{ type: "action", thread: fixture.thread, userId: "user-1", action, approval }]);
        await fixture.channel.resolveApprovalRequest({ message, text: "Decision recorded" });
        expect(fixture.updates).toEqual([{ conversationId: fixture.thread.conversationId, messageId: message.id, text: "Decision recorded", buttonsRemoved: true }]);
      });
    }

    for (const kind of ["not_installed", "not_in_channel", "rate_limited", "auth_expired", "invalid_request"] as const) {
      it(`reports ${kind} with a plain message`, async () => {
        const fixture = create();
        fixture.failPost(kind, true);
        const error = await fixture.channel.postMessage({ thread: fixture.thread, text: "Hello" }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ChannelError);
        expect(error).toMatchObject({ kind, outcomeKnown: true, message: new ChannelError(kind).message });
      });
    }

    it("keeps an uncertain delivery distinguishable from a rejected write", async () => {
      const fixture = create();
      fixture.failPost("invalid_request", false);
      await expect(fixture.channel.postMessage({ thread: fixture.thread, text: "Hello" })).rejects.toMatchObject({ outcomeKnown: false });
    });
  });
}
