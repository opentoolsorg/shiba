import { describe, expect, it } from "vitest";
import { assertChildDispatchAuthorized, sealChildDispatch } from "../src/child-dispatch.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const KEY = "ab".repeat(32);
const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/o/r",
  task: "t",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

describe("child dispatch seal", () => {
  it("accepts a parent-sealed envelope and rejects a forged one", async () => {
    const env = { MODEL_CREDENTIAL_KEY: KEY };
    const seal = await sealChildDispatch(env, {
      approvalId: "agent-tool:abc",
      sandboxId: INPUT.sandboxId,
      inputHash: "c".repeat(64),
    });
    await expect(assertChildDispatchAuthorized(env, { ...INPUT, ...seal })).resolves.toBeUndefined();
    await expect(
      assertChildDispatchAuthorized(env, { ...INPUT, ...seal, dispatchSig: "d".repeat(64) }),
    ).rejects.toThrow(/invalid/i);
  });
});
