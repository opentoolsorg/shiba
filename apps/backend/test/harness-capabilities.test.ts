/**
 * T43 — HarnessCapabilities + verify() gate (PLAN.md §18.4).
 *
 * Pins: (1) every harness's declared capabilities round-trip through the
 * interface; (2) verify rejects an exit-0/empty-diff run — it is NOT
 * completed; (3) the runnability gate still refuses non-sandbox harnesses,
 * now via the capability rather than a name list.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentCliCatalog } from "../src/harness/catalog.js";
import { HARNESS_DEFAULT_MODELS, resolveHarness, harnessRunsOn, harnessIsGated, HARNESSES, SANDBOX_HARNESS_NAMES } from "../src/harness/index.js";
import type { CodingTaskInput, CodingTaskResult } from "../src/opencode-input.js";
import type { AgentHarnessName, HarnessCapabilities } from "../src/harness/types.js";

const CAPABILITY_KEYS = [
  "streamsText",
  "emitsToolCalls",
  "supportsResume",
  "supportsSteering",
  "supportsFileAttachments",
  "canRunTests",
  "supportsConversationRollback",
  "supportedRuntimes",
] as const;

it("keeps the harness canary pins in sync with the runnable catalog and image recipe", () => {
  const pins = JSON.parse(readFileSync(new URL("../../../scripts/harness-canary-pins.json", import.meta.url), "utf8")) as {
    baseImage: string;
    imageInputs: string[];
    cli: Record<string, [string, string]>;
    lanes: Record<string, [string, string]>;
    excluded: Record<string, string>;
  };
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const catalog = agentCliCatalog({});
  const lines = dockerfile.split("\n");
  expect(lines.filter((line) => line.startsWith("FROM "))).toEqual([`FROM ${pins.baseImage}`]);
  const localInputs = lines
    .filter((line) => /^(COPY|ADD) /.test(line) && !line.includes("--from="))
    .flatMap((line) => line.split(/\s+/).slice(1, -1).filter((token) => !token.startsWith("--")));
  const ignoreFiles = [".dockerignore", "Dockerfile.dockerignore"].filter((path) =>
    existsSync(new URL(`../${path}`, import.meta.url)));
  expect(pins.imageInputs).toEqual(["Dockerfile", ...localInputs, ...ignoreFiles].map((path) => `apps/backend/${path}`));
  expect(new Set(Object.keys(pins.lanes))).toEqual(new Set(catalog.map(({ id }) => id)));
  expect([...Object.keys(pins.lanes), ...Object.keys(pins.excluded)].sort()).toEqual(Object.keys(HARNESSES).sort());
  expect(new Set(Object.values(pins.lanes).map(([npmPackage]) => npmPackage))).toEqual(new Set(Object.keys(pins.cli)));
  for (const { id, binary, version } of catalog) {
    const lane = pins.lanes[id];
    if (!lane) throw new Error(`Missing canary lane: ${id}`);
    const [npmPackage, model] = lane;
    expect(pins.cli[npmPackage]).toEqual([binary, version]);
    expect(dockerfile.split(/\s+/)).toContain(`${npmPackage}@${version}`);
    expect(model).toBe(HARNESS_DEFAULT_MODELS[id]);
  }
});

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  task: "edit src/a.ts",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

function completedResult(overrides: Partial<CodingTaskResult> = {}): CodingTaskResult {
  return {
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: ["src/a.ts"],
    diff: "diff --git a/src/a.ts",
    files: [{ path: "src/a.ts", content: "x", encoding: "utf8" }],
    summary: "done",
    ...overrides,
  };
}

describe("declared capabilities", () => {
  it("every harness's declared capabilities round-trip", () => {
    for (const [name, harness] of Object.entries(HARNESSES)) {
      const caps: HarnessCapabilities = harness.capabilities();
      expect(caps, name).toBeTypeOf("object");
      for (const key of CAPABILITY_KEYS) {
        expect(caps[key], `${name}.${key}`).not.toBeUndefined();
      }
      expect(harness.name).toBe(name as AgentHarnessName);
      // supportedRuntimes is an honest list of RuntimeName members.
      for (const runtime of caps.supportedRuntimes) {
        expect(["sandbox", "computer", "local"]).toContain(runtime);
      }
      // model-dependent capabilities resolve without throwing.
      expect(() => harness.capabilities("google/gemini-3.5-flash-lite")).not.toThrow();
    }
  });

  it("derives the sandbox set from capabilities, not a parallel list", () => {
    // T48: opt-in-gated harnesses (claude-subscription) declare the sandbox
    // runtime but are only selectable through sandboxHarnessNames(env) — the
    // static list is the always-on set.
    expect([...SANDBOX_HARNESS_NAMES].sort()).toEqual(
      Object.values(HARNESSES)
        .filter((h) => h.capabilities().supportedRuntimes.includes("sandbox") && !harnessIsGated(h))
        .map((h) => h.name)
        .sort(),
    );
    expect(SANDBOX_HARNESS_NAMES).toContain("opencode");
    expect(SANDBOX_HARNESS_NAMES).not.toContain("cursor");
    expect(SANDBOX_HARNESS_NAMES).not.toContain("antigravity");
  });

  it("declares antigravity's supportsConversationRollback trap as false", () => {
    expect(HARNESSES.antigravity!.capabilities().supportsConversationRollback).toBe(false);
  });
});

describe("verify gate", () => {
  it("rejects a completed result with exit 0 and an empty diff", async () => {
    const empty = completedResult({ changedFiles: [], diff: "", files: [] });
    for (const [name, harness] of Object.entries(HARNESSES)) {
      if (name === "claude-login") continue;
      const verdict = await harness.verify(INPUT, empty);
      expect(verdict, name).toEqual({ ok: false, reason: expect.stringContaining("no file changes") });
    }
  });

  it("accepts a completed result with captured changes", async () => {
    const verdict = await HARNESSES.opencode!.verify(INPUT, completedResult());
    expect(verdict).toEqual({ ok: true });
  });

  it("does not gate non-completed results", async () => {
    const failed = completedResult({ status: "error", summary: "boom" });
    expect(await HARNESSES.opencode!.verify(INPUT, failed)).toEqual({ ok: true });
  });
});

describe("runnability gate via capability", () => {
  it("still refuses non-sandbox harnesses — via supportedRuntimes, not name", () => {
    expect(() => resolveHarness("cursor")).toThrow(/not runnable in a sandbox/);
    expect(() => resolveHarness("antigravity")).toThrow(/not runnable in a sandbox/);
    // The refusal reads the declaration: cursor declares no runtimes.
    expect(HARNESSES.cursor!.capabilities().supportedRuntimes).toEqual([]);
    expect(harnessRunsOn(HARNESSES.cursor!, "sandbox")).toBe(false);
    expect(harnessRunsOn(HARNESSES.opencode!, "sandbox")).toBe(true);
    expect(harnessRunsOn(HARNESSES.pi!, "sandbox")).toBe(true);
    expect(harnessRunsOn(HARNESSES.pi!, "local")).toBe(false);
  });

  it("resolves every capability-declared sandbox harness", () => {
    for (const name of SANDBOX_HARNESS_NAMES) {
      expect(resolveHarness(name).name).toBe(name);
    }
  });
});
