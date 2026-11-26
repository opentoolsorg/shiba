import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OnboardingStatus } from "@shiba/shared";
import { buildSuggestions, DISMISS_TTL_MS, type SuggestionInput } from "../src/needs-you-suggestions.js";

import { createNeedsYouDismissalStore } from "../src/needs-you-dismissals-store.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const base: SuggestionInput = { runs: [], approvals: [], onboarding: null, dismissedIds: new Set(), now: NOW };
const run = (runId: string, task: string, status: string, ageDays = 1) => ({ runId, task, status, createdAt: NOW - ageDays * DAY });
const onboarding = (complete: boolean): OnboardingStatus => ({
  complete, steps: [], remaining: [],
  nextStep: complete ? null : { id: "provider", label: "Connect a model provider", complete: false, target: { kind: "view", view: "providers" } },
});

describe("buildSuggestions", () => {
  it("suggests a retry for failed and cancelled runs in the last 7 days only", () => {
    const out = buildSuggestions({ ...base, runs: [run("a", "Fix flaky test", "error"), run("b", "Bump deps", "cancelled"), run("c", "Old", "error", 8), run("d", "Fine", "completed")] });
    expect(out.map((s) => s.id)).toEqual(["retry:a", "retry:b"]);
    expect(out[0]?.action).toEqual({ kind: "compose", payload: { task: "Fix flaky test" } });
  });

  it("suggests a routine after 3 near-identical runs", () => {
    const runs = [run("a", "Summarize open PRs", "completed"), run("b", "summarize open PRs.", "completed"), run("c", "Summarize open PRs", "completed")];
    const out = buildSuggestions({ ...base, runs });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "routine", action: { kind: "compose" } });
    expect(buildSuggestions({ ...base, runs: runs.slice(0, 2) })).toEqual([]);
    expect(buildSuggestions({ ...base, runs: [runs[0]!, runs[1]!, run("z", "Deploy the staging site now", "completed")] })).toEqual([]);
  });

  it("does not count agent, child, reviewer, or Slack runs as manual repeats", () => {
    const manual = run("a", "Summarize open PRs", "completed");
    for (const metadata of [{ queuedBy: "agent:bot" }, { parentRunId: "parent" }, { reviewOf: "parent" }, { slackCommandOrigin: "slack:channel" }]) {
      expect(buildSuggestions({ ...base, runs: [manual, { ...manual, runId: "b", ...metadata }, { ...manual, runId: "c", ...metadata }] })).toEqual([]);
    }
  });

  it("suggests finishing setup only while onboarding is incomplete", () => {
    expect(buildSuggestions({ ...base, onboarding: onboarding(false) })[0]).toMatchObject({ id: "setup:provider", title: "Finish setup: Connect a model provider" });
    expect(buildSuggestions({ ...base, onboarding: onboarding(true) })).toEqual([]);
  });

  it("groups approvals older than 24h", () => {
    const out = buildSuggestions({ ...base, approvals: [{ createdAt: NOW - 2 * DAY }, { createdAt: NOW - 3 * DAY }, { createdAt: NOW - 1000 }] });
    expect(out[0]).toMatchObject({ kind: "approvals", title: "2 approvals are waiting" });
  });

  it("caps at 3 and skips dismissed ids", () => {
    const input = { ...base, runs: [run("a", "one", "error"), run("b", "two two", "error"), run("c", "three three three", "error")], approvals: [{ createdAt: NOW - 2 * DAY }], onboarding: onboarding(false) };
    expect(buildSuggestions(input)).toHaveLength(3);
    expect(buildSuggestions({ ...input, dismissedIds: new Set(["approvals:stale", "retry:a", "retry:b"]) }).map((s) => s.id)).toEqual(["retry:c", "setup:provider"]);
  });
});

describe("NeedsYouDismissalStore D1 contract", () => {
  function db(): D1Database {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE needs_you_dismissals (owner_id TEXT NOT NULL, suggestion_id TEXT NOT NULL, dismissed_at INTEGER NOT NULL, PRIMARY KEY (owner_id, suggestion_id))");
    return { prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({
      run: async () => sqlite.prepare(sql).run(...(v as never[])),
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...(v as never[])) as T[] }),
    }) }) } as unknown as D1Database;
  }

  it("hides a dismissal for 7 days, per user", async () => {
    const d = createNeedsYouDismissalStore(db());
    await d.dismissSuggestion("u1", "retry:a", NOW);
    expect([...await d.readDismissedIds("u1", NOW + DAY)]).toEqual(["retry:a"]);
    expect((await d.readDismissedIds("u2", NOW + DAY)).size).toBe(0);
    expect((await d.readDismissedIds("u1", NOW + DISMISS_TTL_MS)).size).toBe(0);
    await d.dismissSuggestion("u1", "retry:a", NOW + DAY);
    expect([...await d.readDismissedIds("u1", NOW + DISMISS_TTL_MS)]).toEqual(["retry:a"]);
  });
});
