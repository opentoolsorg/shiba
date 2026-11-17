import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createExtensionSkill, getExtensionSkill } from "../src/extension-skills-store.js";
import { d1LearningPort } from "../src/ports/learning/d1-adapter.js";
import {
  LEARNING_IDLE_MS,
  type LearningThreadRef,
  learningThreadFor,
  learningTrigger,
  parseLearningTurnSetting,
} from "../src/ports/learning/index.js";
import {
  droppedTextShare,
  learningTurnText,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_INSTRUCTIONS,
  parseLearningOutcome,
  runLearningReview,
} from "../src/ports/learning/review.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";

function harness(answer: () => unknown) {
  const { database } = customAgentD1();
  const calls: unknown[] = [];
  const env = {
    AGENT_AUDIT: database,
    AI: {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        return answer();
      },
    },
  } as unknown as Env;
  return { env, port: d1LearningPort(database), calls };
}

const ref: LearningThreadRef = {
  threadKey: "alice#main:run-1",
  orgId: "self-hosted",
  workspaceId: "self-hosted",
  ownerId: "alice",
  employeeId: "agent-1",
};

async function addTurns(
  port: ReturnType<typeof d1LearningPort>,
  count: number,
  start = 0,
  at = 1_000,
) {
  let state = null;
  for (let i = start; i < start + count; i += 1) {
    state = await port.recordTurn(ref, {
      runId: `run-${i}`,
      text: learningTurnText(`task ${i}`, `done ${i}`),
      completedAt: at,
    });
  }
  return state!;
}

describe("learning trigger rules", () => {
  const state = (turnsTotal: number, reviewedThrough = 0, lastTurnAt = 0) => ({
    turnsTotal,
    reviewedThrough,
    lastTurnAt,
  });

  it("fires at the configured turn count and never when off", () => {
    expect(learningTrigger(state(19), 20, "turn", 0)).toBeNull();
    expect(learningTrigger(state(20), 20, "turn", 0)).toBe("turns");
    expect(learningTrigger(state(30, 20), 10, "turn", 0)).toBe("turns");
    expect(learningTrigger(state(39), 40, "turn", 0)).toBeNull();
    expect(learningTrigger(state(100), "off", "turn", 0)).toBeNull();
    expect(learningTrigger(state(100), "off", "idle", LEARNING_IDLE_MS)).toBeNull();
    expect(learningTrigger(state(100), "off", "closed", 0)).toBeNull();
  });

  it("fires after 15 idle minutes only with 3+ new turns", () => {
    expect(learningTrigger(state(3), 20, "idle", LEARNING_IDLE_MS - 1)).toBeNull();
    expect(learningTrigger(state(3), 20, "idle", LEARNING_IDLE_MS)).toBe("idle");
    expect(learningTrigger(state(5, 3), 20, "idle", LEARNING_IDLE_MS)).toBeNull();
  });

  it("fires on close with any unreviewed turn", () => {
    expect(learningTrigger(state(1), 20, "closed", 0)).toBe("closed");
    expect(learningTrigger(state(4, 4), 20, "closed", 0)).toBeNull();
  });

  it("parses only the offered settings", () => {
    expect([10, 20, 40, "off", "20"].map(parseLearningTurnSetting)).toEqual([
      10,
      20,
      40,
      "off",
      20,
    ]);
    expect([5, 0, "on", null].map(parseLearningTurnSetting)).toEqual([null, null, null, null]);
  });

  it("counts main and side threads separately and skips intake, routine and channel threads", () => {
    const run = { runId: "run-2", continuationKey: undefined, parentRunId: undefined };
    expect(learningThreadFor("alice", run, "run-1")?.threadKey).toBe("alice#main:run-1");
    expect(learningThreadFor("alice", { ...run, parentRunId: "run-1" })?.threadKey).toBe(
      "alice#side:run-1",
    );
    expect(learningThreadFor("slack:T1:C1:U1", run)).toBeNull();
    expect(learningThreadFor("teams:tenant:conv", run)).toBeNull();
    expect(learningThreadFor("alice", { ...run, collaborationHandoffId: "handoff-1" })).toBeNull();
    expect(
      learningThreadFor("alice", {
        ...run,
        approval: { decidedBy: "automation:nightly" },
      } as never),
    ).toBeNull();
    expect(learningThreadFor("orchestrator", run)).toBeNull();
  });

  it("counts a replayed completion once", async () => {
    const { port } = harness(() => ({}));
    await port.recordTurn(ref, { runId: "run-x", text: "t", completedAt: 1 });
    const state = await port.recordTurn(ref, { runId: "run-x", text: "t", completedAt: 2 });
    expect(state.turnsTotal).toBe(1);
  });
});

describe("learning review", () => {
  it("does not run before the threshold, then reads only turns since the last review", async () => {
    const answer = {
      response: JSON.stringify({ kind: "none" }),
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    };
    const { env, port, calls } = harness(() => answer);
    await port.setSetting("self-hosted", 10, 0);
    const early = await addTurns(port, 9);
    expect(await runLearningReview(env, port, ref.threadKey, "turn", { state: early })).toEqual({
      status: "skipped",
      reason: "not_due",
    });
    const due = await addTurns(port, 1, 9);
    expect(await runLearningReview(env, port, ref.threadKey, "turn", { state: due })).toMatchObject(
      { status: "reviewed", trigger: "turns" },
    );
    const later = await addTurns(port, 3, 10, 2_000);
    await runLearningReview(env, port, ref.threadKey, "idle", {
      state: later,
      now: 2_000 + LEARNING_IDLE_MS,
    });
    expect(calls).toHaveLength(2);
    const prompt = JSON.stringify(calls[1]);
    expect(prompt).toContain("task 12");
    expect(prompt).not.toContain("task 9");
    expect(prompt).not.toContain('"tools"');
    expect(await port.usageByEmployee("self-hosted")).toEqual([
      { employeeId: "agent-1", inputTokens: 240, outputTokens: 16, reviews: 2 },
    ]);
  });

  it("writes a correction as a new revision of an existing skill", async () => {
    const { env, port } = harness(() => ({}));
    const skillId = await createExtensionSkill(env, ref.orgId, ref.ownerId, {
      name: "Release notes",
      description: "How we write release notes",
      instructions: "Use bullets. Link the PR. Keep it short.",
    });
    const answer = {
      response: JSON.stringify({
        kind: "skill",
        skillId,
        name: "Release notes",
        description: "How we write release notes",
        instructions: "Use bullets. Link the PR. Keep it short. Always name the owner.",
      }),
    };
    const h = {
      ...harness(() => answer),
      env: { ...env, AI: { run: async () => answer } } as unknown as Env,
    };
    const state = await port.closeThread((await addTurns(port, 1)).threadKey, 5_000);
    expect(
      await runLearningReview(h.env, port, ref.threadKey, "closed", { state: state! }),
    ).toMatchObject({ outcome: "skill_revised" });
    expect(await getExtensionSkill(env, ref.orgId, ref.ownerId, skillId)).toMatchObject({
      version: 2,
      instructions: expect.stringContaining("name the owner"),
    });
  });

  it("turns a large rewrite into a Needs-you suggestion instead of applying it", async () => {
    const { env, port } = harness(() => ({}));
    const original =
      "Step one: run the linter. Step two: run unit tests. Step three: build. Step four: deploy to staging first.";
    const skillId = await createExtensionSkill(env, ref.orgId, ref.ownerId, {
      name: "Deploy",
      description: "Deploy checklist",
      instructions: original,
    });
    const answer = {
      response: JSON.stringify({
        kind: "skill",
        skillId,
        name: "Deploy",
        description: "Deploy",
        instructions: "Just deploy.",
      }),
    };
    const reviewEnv = { ...env, AI: { run: async () => answer } } as unknown as Env;
    const state = await port.closeThread((await addTurns(port, 1)).threadKey, 5_000);
    expect(
      await runLearningReview(reviewEnv, port, ref.threadKey, "closed", { state: state! }),
    ).toMatchObject({ outcome: "suggested" });
    expect(await getExtensionSkill(env, ref.orgId, ref.ownerId, skillId)).toMatchObject({
      version: 1,
      instructions: original,
    });
    expect(await port.listSuggestions("self-hosted", "alice")).toMatchObject([
      { skillId, skillVersion: 1, instructions: "Just deploy." },
    ]);
  });

  it("measures dropped text by what the rewrite keeps", () => {
    expect(droppedTextShare("a b c d", "a b c d e")).toBe(0);
    expect(droppedTextShare("a b c d", "a b")).toBe(0.5);
    expect(droppedTextShare("", "anything")).toBe(0);
  });
});

describe("learning output redaction and caps", () => {
  it("redacts secrets and caps description and body length", () => {
    const outcome = parseLearningOutcome({
      response: JSON.stringify({
        kind: "skill",
        name: "Token use",
        description: `Use ${SECRET} ${"d".repeat(1_000)}`,
        instructions: `Auth with ${SECRET}. ${"x".repeat(20_000)}`,
      }),
    });
    expect(outcome.kind).toBe("skill");
    if (outcome.kind !== "skill") return;
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(outcome.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION);
    expect(outcome.instructions.length).toBeLessThanOrEqual(MAX_SKILL_INSTRUCTIONS);
  });

  it("redacts memory facts and turn text before they are stored", () => {
    const fact = parseLearningOutcome({
      response: `{"kind":"memory","fact":"Deploy key is ${SECRET}"}`,
    });
    expect(JSON.stringify(fact)).not.toContain(SECRET);
    expect(learningTurnText(`use ${SECRET}`, "ok")).not.toContain(SECRET);
    expect(parseLearningOutcome({ response: "not json" })).toEqual({ kind: "none" });
  });
});
