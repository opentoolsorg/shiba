import { describe, expect, it } from "vitest";
import {
  deniedApprovalReply,
  emptySlackMirror,
  mirrorIntake,
  mirrorResult,
  mirrorStatus,
} from "../src/slack-thread-mirror.js";

describe("slack thread mirror", () => {
  it("reacts on intake, throttles one status edit, and broadcasts the result", async () => {
    const state = emptySlackMirror();
    const channel = "C_TEST";
    const threadTs = "1710000000.000100";
    await mirrorIntake(state, { channel, threadTs, at: 1_000 });
    await mirrorIntake(state, { channel, threadTs, at: 1_100 });
    expect(state.calls.filter((call) => call.name === "eyes")).toHaveLength(1);
    expect(state.calls[0]?.at).toBeLessThanOrEqual(1_000 + 3_000);

    await mirrorStatus(state, { channel, threadTs, text: "Working · reading files", editKey: "status", at: 2_000 });
    await mirrorStatus(state, { channel, threadTs, text: "Working · editing", editKey: "status", at: 3_000 });
    expect(state.calls.filter((call) => call.method === "chat.update")).toHaveLength(0);
    await mirrorStatus(state, { channel, threadTs, text: "Working · editing 3 files", editKey: "status", at: 5_000 });
    const updates = state.calls.filter((call) => call.method === "chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toBe("Working · editing 3 files");
    expect(updates[0]?.ts).toBe(state.statusTs);

    await mirrorResult(state, { channel, threadTs, text: "Pushed the fix.", editKey: "result", at: 9_000 });
    await mirrorResult(state, { channel, threadTs, text: "Pushed the fix.", editKey: "result", at: 9_100 });
    const result = state.calls.find((call) => call.replyBroadcast);
    expect(result?.threadTs).toBe(threadTs);
    expect(state.calls.filter((call) => call.name === "white_check_mark")).toHaveLength(1);
    expect(state.calls.every((call) => call.threadTs === undefined || call.threadTs === threadTs)).toBe(true);
  });

  it("strips approval buttons and posts one denial line", () => {
    expect(deniedApprovalReply()).toEqual({ text: "Stopped. Nothing ran.", blocks: [] });
  });
});