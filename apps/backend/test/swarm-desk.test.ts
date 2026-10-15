import { describe, expect, it } from "vitest";
import {
  laneForRun,
  modeForRole,
  normalizeSwarmWebhook,
  parseSwarmIntake,
  projectSwarmDesk,
  roleForMode,
  type SwarmRunInput,
} from "../../../packages/shared/src/swarm-desk.js";

function makeRun(overrides: Partial<SwarmRunInput> = {}): SwarmRunInput {
  return {
    runId: "run-1",
    task: "Do the work",
    repoUrl: "https://github.com/acme/project",
    status: "pending",
    baseBranch: "main",
    updatedAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

describe("swarm desk projection", () => {
  it.each([
    ["pending", "backlog"],
    ["running", "in_progress"],
    ["completed", "needs_review"],
    ["error", "archived"],
    ["aborted", "archived"],
    ["cancelled", "archived"],
    ["unknown", "archived"],
  ] as const)("maps %s runs to the %s lane", (status, lane) => {
    expect(laneForRun({ status })).toBe(lane);
    expect(projectSwarmDesk([makeRun({ status })])[lane]).toHaveLength(1);
  });

  it("keeps completed runs in needs_review with or without a pull URL", () => {
    expect(laneForRun({ status: "completed", pullUrl: "https://github.com/acme/project/pull/1" })).toBe(
      "needs_review",
    );
    expect(laneForRun({ status: "completed" })).toBe("needs_review");
    expect(projectSwarmDesk([makeRun({ status: "completed" })]).needs_review).toHaveLength(1);
  });

  it("sorts each lane by updatedAt descending, then runId ascending", () => {
    const desk = projectSwarmDesk([
      makeRun({ runId: "z", updatedAt: 5 }),
      makeRun({ runId: "b", updatedAt: 10 }),
      makeRun({ runId: "a", updatedAt: 10 }),
      makeRun({ runId: "c", updatedAt: 3 }),
    ]);
    expect(desk.backlog.map(({ runId }) => runId)).toEqual(["a", "b", "z", "c"]);
  });

  it("uses the trimmed first task line as title and truncates it at 80 characters", () => {
    expect(projectSwarmDesk([makeRun({ task: "  First line  \nSecond line" })]).backlog[0]?.title).toBe(
      "First line",
    );
    expect(projectSwarmDesk([makeRun({ task: "  \nSecond line" })]).backlog[0]?.title).toBe("Untitled thread");
    const longTitle = "x".repeat(81);
    expect(projectSwarmDesk([makeRun({ task: longTitle })]).backlog[0]?.title).toBe("x".repeat(80));
  });
});

describe("swarm modes", () => {
  it.each([
    ["orchestrator", "captain"],
    ["reviewer", "review"],
    ["fixer", "build"],
    ["explorer", "build"],
    ["designer", "build"],
    [undefined, "build"],
  ] as const)("maps role %s to mode %s", (role, mode) => {
    expect(modeForRole(role)).toBe(mode);
  });

  it.each([
    ["captain", "orchestrator"],
    ["build", "fixer"],
    ["review", "reviewer"],
  ] as const)("maps mode %s to role %s", (mode, role) => {
    expect(roleForMode(mode)).toBe(role);
  });
});

describe("swarm intake parsing", () => {
  it("parses a Linear issue URL", () => {
    const url = "https://linear.app/acme/issue/ENG-123/fix-the-login";
    expect(parseSwarmIntake(url)).toEqual({
      source: "linear",
      externalId: "ENG-123",
      title: "Fix the login",
      prompt: `Linear ENG-123: Fix the login\n${url}`,
      url,
    });
  });

  it("parses a bare Linear key without adding a URL line", () => {
    expect(parseSwarmIntake("ENG-123: Fix the login")).toEqual({
      source: "linear",
      externalId: "ENG-123",
      title: "Fix the login",
      prompt: "Linear ENG-123: Fix the login",
      url: undefined,
    });
  });

  it("parses a Sentry issue URL", () => {
    const url = "https://sentry.io/organizations/acme/issues/12345";
    expect(parseSwarmIntake(url)).toEqual({
      source: "sentry",
      externalId: "12345",
      title: "Sentry issue 12345",
      prompt: `Sentry 12345: Sentry issue 12345\n${url}`,
      url,
    });
  });

  it("preserves plain text as the prompt and uses its first line as title", () => {
    expect(parseSwarmIntake("  Do something useful\nwith details  ")).toEqual({
      source: "plain",
      title: "Do something useful",
      prompt: "Do something useful\nwith details",
      externalId: undefined,
      url: undefined,
    });
  });

  it("returns empty fields for blank input", () => {
    expect(parseSwarmIntake(" \n\t ")).toEqual({
      source: "plain",
      title: "",
      prompt: "",
      externalId: undefined,
      url: undefined,
    });
  });
});

describe("swarm webhook normalization", () => {
  it("normalizes Linear webhook data", () => {
    expect(normalizeSwarmWebhook({ data: { identifier: "ENG-1", title: "T", url: "u" } })).toEqual({
      source: "linear",
      externalId: "ENG-1",
      title: "T",
      prompt: "Linear ENG-1: T\nu",
      url: "u",
    });
  });

  it("normalizes Sentry webhook data", () => {
    expect(normalizeSwarmWebhook({ data: { issue: { title: "T", shortId: "P-1", permalink: "u" } } })).toEqual({
      source: "sentry",
      externalId: "P-1",
      title: "T",
      prompt: "Sentry P-1: T\nu",
      url: "u",
    });
  });

  it.each([{}, null])("returns null for invalid webhook body %s", (body) => {
    expect(normalizeSwarmWebhook(body)).toBeNull();
  });
});
