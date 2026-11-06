import { describe, expect, it } from "vitest";
import { RUN_DEADLINE_MS } from "@shiba/shared";
import { assertChildDispatchAuthorized, childDispatchEnvelopeHash, sealChildDispatch } from "../src/child-dispatch.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const KEY = "ab".repeat(32);
const NOW = 1_800_000_000_000;
const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/o/r",
  task: "t",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};
const APPROVED_ROUTE: NonNullable<CodingTaskInput["route"]> = {
  purpose: "coding", connectionId: null, modelId: INPUT.codingModel, harness: "opencode", policyVersion: 1,
};

const FULL_INPUT: CodingTaskInput = {
  ...INPUT,
  orgId: "self-hosted",
  sandboxProvider: "cloudflare",
  customAgentId: "agent-one",
  customAgentVersion: 1,
  skillPins: [{ skillId: `skill-${"a".repeat(24)}`, version: 1, name: "Review" }],
  harness: "opencode",
  role: "fixer",
  authAccount: "default",
  initiatorUserId: "owner@example.test",
  chatgptAccessToken: "DUMMY_PROVIDER_KEY",
  chatgptThreadId: "thread-one",
  codexAuthMode: "siwc",
  route: APPROVED_ROUTE,
  slackThread: { channelId: "C123", threadTs: "1.2" },
  testCommand: ["pnpm", "test"],
  expectedDeliverables: ["report.md", "summary.txt"],
  executionTarget: { kind: "repository", repoUrl: INPUT.repoUrl, baseBranch: INPUT.baseBranch },
  forkCheckpointRef: "refs/shiba/checkpoints/run-one/1",
  runSetup: false,
  envSealed: "sealed-owner-input",
  envDigest: "e".repeat(64),
  accessAgent: "owner@example.test",
  envOwner: "owner@example.test",
  runRoom: { ownerId: "owner@example.test", sessionId: "session-one", runId: "run-one" },
  runtime: "sandbox",
  targetMachineId: "machine-one",
};

async function seal(input = INPUT) {
  return sealChildDispatch({ MODEL_CREDENTIAL_KEY: KEY }, {
    approvalId: "agent-tool:abc",
    sandboxId: input.sandboxId,
    inputHash: "c".repeat(64),
  }, input, NOW);
}

describe("child dispatch seal", () => {
  it("accepts a parent-sealed envelope and rejects a forged one", async () => {
    const env = { MODEL_CREDENTIAL_KEY: KEY };
    const seal = await sealChildDispatch(env, {
      approvalId: "agent-tool:abc",
      sandboxId: INPUT.sandboxId,
      inputHash: "c".repeat(64),
    }, INPUT);
    await expect(assertChildDispatchAuthorized(env, { ...INPUT, ...seal })).resolves.toBeUndefined();
    await expect(
      assertChildDispatchAuthorized(env, { ...INPUT, ...seal, dispatchSig: "d".repeat(64) }),
    ).rejects.toThrow(/invalid/i);
  });
  it("binds every execution and owner routing field to the parent seal", async () => {
    const env = { MODEL_CREDENTIAL_KEY: KEY };
    const sealed = { ...FULL_INPUT, ...await seal(FULL_INPUT) };
    const changes: Partial<CodingTaskInput>[] = [
      { task: "Different task" },
      { repoUrl: "https://github.com/other/repo", executionTarget: { kind: "repository", repoUrl: "https://github.com/other/repo", baseBranch: INPUT.baseBranch } },
      { baseBranch: "release", executionTarget: { kind: "repository", repoUrl: INPUT.repoUrl, baseBranch: "release" } },
      { sandboxId: "run-other" },
      { publishPullRequest: true },
      { codingModel: "openai/gpt-5.3-codex" },
      { harness: "codex" },
      { role: "reviewer" },
      { orgId: "other-org" },
      { sandboxProvider: "other-provider" },
      { customAgentId: "agent-two" },
      { customAgentVersion: 2 },
      { skillPins: [{ skillId: `skill-${"a".repeat(24)}`, version: 2, name: "Review" }] },
      { authAccount: "other-account" },
      { initiatorUserId: "other@example.test" },
      { chatgptAccessToken: "OTHER_DUMMY_PROVIDER_KEY" },
      { chatgptThreadId: "thread-two" },
      { codexAuthMode: "device-auth" },
      { route: { ...APPROVED_ROUTE, connectionId: "other-connection" } },
      { slackThread: { channelId: "C456", threadTs: "2.3" } },
      { testCommand: ["pnpm", "build"] },
      { expectedDeliverables: ["summary.txt", "report.md"] },
      { executionTarget: undefined },
      { forkCheckpointRef: "refs/shiba/checkpoints/run-other/2" },
      { runSetup: true },
      { envSealed: "other-sealed-input" },
      { envDigest: "f".repeat(64) },
      { envOwner: "other-owner" },
      { accessAgent: "other-owner" },
      { runtime: "local" },
      { targetMachineId: "machine-two" },
      { runRoom: { ownerId: "other-owner", sessionId: "default", runId: "forged" } },
      { dispatchApprovalId: "other-approval" },
      { dispatchInputHash: "d".repeat(64) },
      { dispatchEnvelopeHash: "d".repeat(64) },
      { dispatchIssuedAt: NOW - 1 },
      { dispatchExpiresAt: NOW + RUN_DEADLINE_MS - 1 },
    ];
    await expect(assertChildDispatchAuthorized(env, sealed, NOW)).resolves.toBeUndefined();
    for (const change of changes) {
      await expect(assertChildDispatchAuthorized(env, { ...sealed, ...change }, NOW), JSON.stringify(Object.keys(change)))
        .rejects.toThrow();
    }
  });

  it("accepts equivalent objects with different top level and nested key order", async () => {
    const envelope = await seal(FULL_INPUT);
    const reordered: CodingTaskInput = {
      ...Object.fromEntries(Object.entries(FULL_INPUT).reverse()) as CodingTaskInput,
      runRoom: { runId: "run-one", sessionId: "session-one", ownerId: "owner@example.test" },
      slackThread: { threadTs: "1.2", channelId: "C123" },
      route: { policyVersion: 1, harness: "opencode", modelId: INPUT.codingModel, connectionId: null, purpose: "coding" },
    };
    expect(await childDispatchEnvelopeHash(FULL_INPUT)).toBe(await childDispatchEnvelopeHash(reordered));
    await expect(assertChildDispatchAuthorized({ MODEL_CREDENTIAL_KEY: KEY }, { ...reordered, ...envelope }, NOW))
      .resolves.toBeUndefined();
  });

  it("binds repo free workspace identity and template to the seal", async () => {
    const workspace = { kind: "artifact-workspace" as const, workspaceId: "workspace-one", template: "research", expectedDeliverables: [] };
    const input: CodingTaskInput = {
      ...INPUT,
      repoUrl: "",
      runtime: "sandbox",
      expectedDeliverables: [],
      executionTarget: workspace,
    };
    const envelope = await seal(input);
    await expect(assertChildDispatchAuthorized({ MODEL_CREDENTIAL_KEY: KEY }, { ...input, ...envelope }, NOW)).resolves.toBeUndefined();
    for (const change of [{ workspaceId: "workspace-two" }, { template: "marketing" }]) {
      const executionTarget = { ...workspace, ...change };
      await expect(assertChildDispatchAuthorized({ MODEL_CREDENTIAL_KEY: KEY }, { ...input, ...envelope, executionTarget }, NOW))
        .rejects.toThrow(/envelope changed/);
    }
  });

  it("rejects missing evidence and missing signing configuration", async () => {
    const env = { MODEL_CREDENTIAL_KEY: KEY };
    const sealed = { ...INPUT, ...await seal() };
    await expect(assertChildDispatchAuthorized(env, INPUT, NOW)).rejects.toThrow(/approved parent/);
    for (const field of ["dispatchApprovalId", "dispatchInputHash", "dispatchEnvelopeHash", "dispatchSig"] as const) {
      await expect(assertChildDispatchAuthorized(env, { ...sealed, [field]: undefined }, NOW)).rejects.toThrow(/approved parent/);
    }
    await expect(assertChildDispatchAuthorized({}, sealed, NOW)).rejects.toThrow(/not configured/);
    await expect(sealChildDispatch({}, { approvalId: "abc", sandboxId: INPUT.sandboxId, inputHash: "c".repeat(64) }, INPUT, NOW))
      .rejects.toThrow(/not configured/);
  });

  it("expires exactly at the run deadline and refuses future or extended timestamps", async () => {
    const env = { MODEL_CREDENTIAL_KEY: KEY };
    const sealed = { ...INPUT, ...await seal() };
    expect(sealed.dispatchExpiresAt).toBe(NOW + RUN_DEADLINE_MS);
    await expect(assertChildDispatchAuthorized(env, sealed, NOW + RUN_DEADLINE_MS - 1)).resolves.toBeUndefined();
    await expect(assertChildDispatchAuthorized(env, sealed, NOW + RUN_DEADLINE_MS)).rejects.toThrow(/deadline/);
    await expect(assertChildDispatchAuthorized(env, sealed, NOW - 1)).rejects.toThrow(/deadline/);
    for (const change of [
      { dispatchExpiresAt: NOW + RUN_DEADLINE_MS + 1 },
      { dispatchIssuedAt: undefined },
      { dispatchExpiresAt: undefined },
      { dispatchIssuedAt: NOW + 1 },
      { dispatchExpiresAt: NOW },
    ]) {
      await expect(assertChildDispatchAuthorized(env, { ...sealed, ...change }, NOW)).rejects.toThrow(/deadline/);
    }
  });

  it("does not accept a seal created under a different signing key", async () => {
    const sealed = { ...INPUT, ...await seal() };
    await expect(assertChildDispatchAuthorized({ MODEL_CREDENTIAL_KEY: "cd".repeat(32) }, sealed, NOW)).rejects.toThrow(/invalid/);
    await expect(assertChildDispatchAuthorized({ MODEL_CREDENTIAL_KEY: KEY, INTERNAL_SIGNING_KEY: "another-key" }, sealed, NOW)).rejects.toThrow(/invalid/);
  });
});
