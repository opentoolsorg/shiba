import { describe, expect, it, vi } from "vitest";

vi.mock("agents/routing", () => ({
  getAgentByName: async (ns: { get?: (name: string) => unknown }, name: string) => {
    if (ns && typeof ns.get === "function") {
      return ns.get(name);
    }
    return { fetch: async () => new Response("{}", { status: 404 }) };
  },
}));

import {
  ACTIVITY_DAYS_DEFAULT,
  CONTRIBUTION_DAYS,
  buildActivityReport,
  parseActivityDays,
  parseActivityPeriod,
  parseActivityRuntime,
} from "../src/activity.js";
import { handleActivity } from "../src/activity-routes.js";
import { createRun, type DelegatedRun } from "../src/runs.js";
import { evidenceFor } from "./seeding.js";
import type { Env } from "../src/env.js";

const INPUT = {
  repoUrl: "https://github.com/o/r",
  task: "fix",
  baseBranch: "main",
  publishPullRequest: false,
};

function makeRun(overrides: Partial<DelegatedRun>): DelegatedRun {
  return {
    ...createRun({
      runId: "r1",
      sandboxId: "s1",
      ...INPUT,
      approval: evidenceFor(INPUT),
      now: 1000,
    }),
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// 2026-10-02 12:00 UTC — mid-day so windows straddle calendar boundaries.
const NOW = Date.UTC(2026, 9, 2, 12);
const PERIOD = { from: NOW - 30 * DAY, to: NOW };

function note(at: number): NonNullable<DelegatedRun["steering"]>[number] {
  return { at, message: "steer", kind: "queued" };
}

describe("parseActivityDays / parseActivityRuntime", () => {
  it("days accepts only the presets and defaults on junk", () => {
    expect(parseActivityDays(null)).toBe(ACTIVITY_DAYS_DEFAULT);
    expect(parseActivityDays("7")).toBe(7);
    expect(parseActivityDays("30")).toBe(30);
    expect(parseActivityDays("90")).toBe(90);
    expect(parseActivityDays("14")).toBe(ACTIVITY_DAYS_DEFAULT);
    expect(parseActivityDays("x")).toBe(ACTIVITY_DAYS_DEFAULT);
  });

  it("runtime accepts cloud/local and defaults on junk", () => {
    expect(parseActivityRuntime(null)).toBe("all");
    expect(parseActivityRuntime("all")).toBe("all");
    expect(parseActivityRuntime("cloud")).toBe("cloud");
    expect(parseActivityRuntime("local")).toBe("local");
    expect(parseActivityRuntime("mars")).toBe("all");
  });
});

describe("parseActivityPeriod", () => {
  it("defaults to a 30-day window ending at now", () => {
    expect(parseActivityPeriod(new URLSearchParams(), NOW)).toEqual({
      from: NOW - 30 * DAY,
      to: NOW,
    });
    expect(parseActivityPeriod(new URLSearchParams("days=7"), NOW)).toEqual({
      from: NOW - 7 * DAY,
      to: NOW,
    });
  });

  it("accepts a custom epoch-ms range, bounded to 365 days", () => {
    expect(parseActivityPeriod(new URLSearchParams("from=1000&to=2000"), NOW)).toEqual({
      from: 1000,
      to: 2000,
    });
    // A full-year span is allowed; a day more is not.
    const ok = parseActivityPeriod(new URLSearchParams(`from=0&to=${365 * DAY}`), NOW);
    expect(ok).toEqual({ from: 0, to: 365 * DAY });
    expect("error" in parseActivityPeriod(new URLSearchParams(`from=0&to=${366 * DAY}`), NOW)).toBe(
      true,
    );
  });

  it("rejects inverted, malformed, and half-specified ranges", () => {
    for (const query of ["from=2000&to=1000", "from=abc&to=1", "from=1000", "to=1000", "from="]) {
      const parsed = parseActivityPeriod(new URLSearchParams(query), NOW);
      expect("error" in parsed, query).toBe(true);
    }
  });
});

describe("buildActivityReport", () => {
  const runs = [
    // Current window.
    makeRun({ runId: "c1", status: "completed", createdAt: NOW - DAY, updatedAt: NOW - DAY + 2 * HOUR, queuedBy: "alice" }),
    makeRun({ runId: "e1", status: "error", createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY + HOUR }),
    makeRun({ runId: "u1", status: "unknown", createdAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY + 3 * HOUR }),
    makeRun({ runId: "p1", status: "completed", pullUrl: "https://github.com/o/r/pull/1", createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY + HOUR, queuedBy: "alice" }),
    makeRun({ runId: "p3", status: "completed", pullUrl: "https://github.com/o/r/pull/3", createdAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY + HOUR / 2 }),
    makeRun({ runId: "p4", status: "completed", pullUrl: "https://github.com/o/r/pull/4", createdAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY + HOUR, queuedBy: "alice" }),
    makeRun({ runId: "s1", status: "completed", createdAt: NOW - DAY, updatedAt: NOW - DAY + HOUR / 2, steering: [note(NOW), note(NOW + 1)] }),
    // Not terminal — counts in the heatmap but in no metric.
    makeRun({ runId: "run1", status: "running", createdAt: NOW - DAY, updatedAt: NOW - DAY + 9 * HOUR }),
    // Previous window ([NOW-60d, NOW-30d)).
    makeRun({ runId: "c2", status: "completed", createdAt: NOW - 40 * DAY, updatedAt: NOW - 40 * DAY + HOUR, queuedBy: "bob", repoUrl: "https://github.com/o/z" }),
    makeRun({ runId: "a1", status: "aborted", createdAt: NOW - 45 * DAY, updatedAt: NOW - 45 * DAY + HOUR }),
    makeRun({ runId: "c3", status: "cancelled", createdAt: NOW - 35 * DAY, updatedAt: NOW - 35 * DAY + HOUR / 2 }),
    makeRun({ runId: "p2", status: "completed", pullUrl: "https://github.com/o/z/pull/2", createdAt: NOW - 50 * DAY, updatedAt: NOW - 50 * DAY + HOUR, queuedBy: "bob", repoUrl: "https://github.com/o/z" }),
    // Outside both windows — heatmap and pick lists only.
    makeRun({ runId: "old", status: "completed", createdAt: NOW - 80 * DAY, updatedAt: NOW - 80 * DAY + HOUR, queuedBy: "" }),
    // Older than the heatmap — pick lists only.
    makeRun({ runId: "ancient", status: "completed", createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY + HOUR, queuedBy: "carol" }),
  ];

  it("buckets metrics into the current and previous windows by createdAt", () => {
    const report = buildActivityReport(runs, { period: PERIOD, now: NOW });
    expect(report.period).toEqual(PERIOD);
    expect(report.previous).toEqual({ from: NOW - 60 * DAY, to: NOW - 30 * DAY });
    expect(report.generatedAt).toBe(NOW);
    expect(report.metrics.contribution).toEqual({ now: 5, last: 2 }); // completed: c1,p1,p3,p4,s1 | c2,p2
    expect(report.metrics.issuesDetected).toEqual({ now: 2, last: 1 }); // e1,u1 | a1 (c3 cancelled)
    expect(report.metrics.prsContributed).toEqual({ now: 3, last: 1 }); // p1,p3,p4 | p2
    expect(report.metrics.prsMerged).toEqual({ now: null, last: null });
    expect(report.metrics.feedbackLoops).toEqual({ now: 2, last: 0 });
    expect(report.metrics.agentHours).toEqual({ now: 9, last: 3.5 });
  });

  it("ends an archived run's agent time at its last receipt, not the archive", () => {
    const archived = makeRun({
      runId: "arch",
      status: "completed",
      createdAt: NOW - 2 * DAY,
      receipts: [{ at: NOW - 2 * DAY + HOUR, kind: "submit", message: "done" }],
      archivedAt: NOW - DAY,
      updatedAt: NOW - DAY,
    });
    const report = buildActivityReport([archived], { period: PERIOD, now: NOW });
    expect(report.metrics.agentHours.now).toBe(1);
  });

  it("lists distinct projects and members over all runs, unfiltered", () => {
    const report = buildActivityReport(runs, {
      period: PERIOD,
      now: NOW,
      project: "https://github.com/o/z",
      member: "bob",
    });
    expect(report.projects).toEqual(["https://github.com/o/r", "https://github.com/o/z"]);
    // The empty queuedBy is excluded; the list ignores the member filter.
    expect(report.members).toEqual(["alice", "bob", "carol"]);
    // The filter still applies to the metrics themselves.
    expect(report.metrics.contribution).toEqual({ now: 0, last: 2 });
  });

  it("emits a 364-day contribution heatmap ending today, oldest first", () => {
    const report = buildActivityReport(runs, { period: PERIOD, now: NOW });
    expect(report.contribution).toHaveLength(CONTRIBUTION_DAYS);
    const first = report.contribution[0];
    const last = report.contribution[report.contribution.length - 1];
    expect(first?.date).toBe(new Date(Date.UTC(2026, 9, 2) - (CONTRIBUTION_DAYS - 1) * DAY).toISOString().slice(0, 10));
    expect(last?.date).toBe("2026-10-02");
    const day = (date: string) => report.contribution.find((d) => d.date === date)?.count;
    expect(day("2026-10-01")).toBe(3); // c1, s1, run1 — all runs, not just completed
    expect(day("2026-09-29")).toBe(1); // p1
    expect(day("2026-07-14")).toBe(1); // old — in the heatmap though outside both windows
    expect(day("2026-09-10")).toBe(0); // inside the window, no runs
  });

  it("fills pullRequests.total per UTC day of the period and byMember desc", () => {
    const report = buildActivityReport(runs, { period: PERIOD, now: NOW });
    // Sep 2 00:00 through Oct 2 00:00 — 31 calendar days touched by the window.
    expect(report.pullRequests.total).toHaveLength(31);
    expect(report.pullRequests.total[0]?.date).toBe("2026-09-02");
    expect(report.pullRequests.total[30]?.date).toBe("2026-10-02");
    const day = (date: string) => report.pullRequests.total.find((d) => d.date === date)?.count;
    expect(day("2026-09-29")).toBe(1);
    expect(day("2026-09-28")).toBe(1);
    expect(day("2026-09-27")).toBe(1);
    expect(day("2026-10-02")).toBe(0);
    expect(report.pullRequests.byMember).toEqual([
      { member: "alice", count: 2 },
      { member: "unknown", count: 1 },
    ]);
  });

  it("applies the runtime filter — missing runtime counts as cloud", () => {
    const set = [
      makeRun({ runId: "s", status: "completed", createdAt: NOW - DAY, updatedAt: NOW - DAY + HOUR }),
      makeRun({ runId: "sb", status: "completed", createdAt: NOW - DAY, updatedAt: NOW - DAY + HOUR, runtime: "sandbox" }),
      makeRun({ runId: "l", status: "completed", createdAt: NOW - DAY, updatedAt: NOW - DAY + HOUR, runtime: "local" }),
    ];
    expect(buildActivityReport(set, { period: PERIOD, now: NOW }).metrics.contribution.now).toBe(3);
    expect(
      buildActivityReport(set, { period: PERIOD, now: NOW, runtime: "cloud" }).metrics.contribution.now,
    ).toBe(2);
    expect(
      buildActivityReport(set, { period: PERIOD, now: NOW, runtime: "local" }).metrics.contribution.now,
    ).toBe(1);
  });

  it("applies exact project and member filters", () => {
    const set = [
      makeRun({ runId: "a", status: "completed", createdAt: NOW - DAY, updatedAt: NOW, queuedBy: "alice" }),
      makeRun({ runId: "b", status: "completed", createdAt: NOW - DAY, updatedAt: NOW, queuedBy: "bob", repoUrl: "https://github.com/o/z" }),
    ];
    const byProject = buildActivityReport(set, { period: PERIOD, now: NOW, project: "https://github.com/o/z" });
    expect(byProject.metrics.contribution.now).toBe(1);
    expect(byProject.contribution.find((d) => d.date === "2026-10-01")?.count).toBe(1);
    const byMember = buildActivityReport(set, { period: PERIOD, now: NOW, member: "alice" });
    expect(byMember.metrics.contribution.now).toBe(1);
    const noMatch = buildActivityReport(set, { period: PERIOD, now: NOW, member: "nobody" });
    expect(noMatch.metrics.contribution.now).toBe(0);
  });
});

describe("GET /api/activity", () => {
  const envWithRuns = (runs: DelegatedRun[], extra: Partial<Env> = {}): Env =>
    ({
      CodingOrchestrator: {
        get: () => ({
          fetch: async () => Response.json({ runs }),
        }),
      },
      ...extra,
    }) as unknown as Env;

  it("returns the report over the run store, honoring ?days", async () => {
    const recent = Date.now() - DAY;
    const seeded = [
      makeRun({ runId: "r1", status: "completed", createdAt: recent, updatedAt: recent + HOUR }),
      makeRun({ runId: "r2", status: "completed", createdAt: Date.now() - 10 * DAY, updatedAt: Date.now() - 10 * DAY + HOUR }),
    ];
    const report = (await (
      await handleActivity(new Request("http://localhost/api/activity"), envWithRuns(seeded))
    )!.json()) as { period: { from: number; to: number }; metrics: { contribution: { now: number | null } }; contribution: unknown[]; metrics2?: never };
    expect(report.period.to - report.period.from).toBe(30 * DAY);
    expect(report.metrics.contribution.now).toBe(2);
    expect(report.contribution).toHaveLength(364);

    const week = (await (
      await handleActivity(new Request("http://localhost/api/activity?days=7"), envWithRuns(seeded))
    )!.json()) as { period: { from: number; to: number }; metrics: { contribution: { now: number | null } } };
    expect(week.period.to - week.period.from).toBe(7 * DAY);
    // The 10-day-old run falls into the previous window now.
    expect(week.metrics.contribution.now).toBe(1);
  });

  it("400s on a malformed custom range", async () => {
    const env = envWithRuns([]);
    for (const query of ["from=2000&to=1000", "from=abc&to=1", "from=1000"]) {
      const response = await handleActivity(new Request(`http://localhost/api/activity?${query}`), env);
      expect(response?.status, query).toBe(400);
      expect(await response!.json()).toMatchObject({ error: expect.stringContaining("Invalid range") });
    }
  });

  it("does not forward caller-supplied vouched headers into the DO", async () => {
    // Same strip as handleUsage: X-Agent-Principal and X-Shiba-Intake read as
    // worker-vouched inside the DO — the forwarded read must carry neither.
    const forwarded: Headers[] = [];
    const env = {
      CodingOrchestrator: {
        get: () => ({
          fetch: async (request: Request) => {
            forwarded.push(request.headers);
            return Response.json({ runs: [] });
          },
        }),
      },
    } as unknown as Env;
    const response = await handleActivity(
      new Request("http://localhost/api/activity", {
        headers: { "X-Agent-Principal": "forged", "X-Shiba-Intake": "local" },
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(forwarded[0]?.get("X-Agent-Principal")).toBeNull();
    expect(forwarded[0]?.get("X-Shiba-Intake")).toBeNull();
  });

  it("rejects non-GET and passes a dead run store through", async () => {
    const post = await handleActivity(
      new Request("http://localhost/api/activity", { method: "POST" }),
      envWithRuns([]),
    );
    expect(post?.status).toBe(405);
    const env = {
      CodingOrchestrator: { get: () => ({ fetch: async () => new Response("nope", { status: 503 }) }) },
    } as unknown as Env;
    const dead = await handleActivity(new Request("http://localhost/api/activity"), env);
    expect(dead?.status).toBe(503);
    expect(await handleActivity(new Request("http://localhost/api/not-activity"), envWithRuns([]))).toBeNull();
  });

  it("401s when Access is configured and the request carries no identity", async () => {
    const env = envWithRuns([], { REQUIRE_ACCESS: "1" } as Partial<Env>);
    const response = await handleActivity(new Request("http://localhost/api/activity"), env);
    expect(response?.status).toBe(401);
  });
});
