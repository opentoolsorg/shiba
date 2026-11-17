import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestratorStateSql } from "../src/agents/orchestrator-state-sql.js";
import { OrchestratorReviews } from "../src/agents/orchestrator-reviews.js";
import { createRun } from "../src/runs.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import type { ReviewRound } from "@shiba/shared";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({}) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY, state TEXT)");
  const storage = {
    sql: {
      exec(query: string, ...values: SQLInputValue[]) {
        const statement = database.prepare(query);
        if (statement.columns().length) return statement.all(...values);
        statement.run(...values);
        return [];
      },
    },
    transactionSync<T>(callback: () => T): T {
      database.exec("BEGIN");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const query = <T>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) =>
    orchestratorStateSql<T>(
      storage,
      strings,
      values,
      (bindings) =>
        [
          ...storage.sql.exec(strings.join("?"), ...(bindings as (string | number | null)[])),
        ] as T[],
    );
  const read = () => {
    const rows = query<{
      state: string;
    }>`SELECT state FROM cf_agents_state WHERE id = ${"cf_state_row_id"}`;
    return rows[0] ? JSON.parse(rows[0].state) : undefined;
  };
  const write = (state: unknown) =>
    query`INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (${"cf_state_row_id"}, ${JSON.stringify(state)})`;
  const raw = () =>
    JSON.parse(
      (
        database
          .prepare("SELECT state FROM cf_agents_state WHERE id = ?")
          .get("cf_state_row_id") as { state: string }
      ).state,
    );
  const legacy = (state: unknown) =>
    database
      .prepare("INSERT OR REPLACE INTO cf_agents_state VALUES (?, ?)")
      .run("cf_state_row_id", JSON.stringify(state));
  return { database, storage, query, read, write, raw, legacy };
}

describe("orchestrator SQLite collection persistence", () => {
  it.each(["missing", "broken"])(
    "rejects a %s SDK manifest instead of resetting persisted collections",
    (damage) => {
      const f = fixture();
      f.write({ runs: [{ runId: "retained" }] });
      f.database.exec(
        damage === "missing"
          ? "DELETE FROM cf_agents_state"
          : "UPDATE cf_agents_state SET state = 'broken'",
      );
      expect(
        () => f.query`SELECT state FROM cf_agents_state WHERE id = ${"cf_state_row_id"}`,
      ).toThrow();
      expect(
        f.database.prepare("SELECT count(*) AS n FROM shiba_orchestrator_collections").get(),
      ).toMatchObject({ n: 1 });
    },
  );
  it("can read an empty run store before the SDK assigns an agent name", () => {
    const host = Object.create(CodingOrchestrator.prototype);
    Object.defineProperty(host, "state", { value: { runs: [] } });
    Object.defineProperty(host, "name", {
      get() {
        throw new Error("not named yet");
      },
    });
    expect(host.store.list()).toEqual([]);
  });
  it("rejects a malformed manifest instead of returning an empty state", () => {
    const f = fixture();
    f.write({ runs: [] });
    f.database
      .prepare("UPDATE cf_agents_state SET state = ?")
      .run(JSON.stringify({ ...f.raw(), metadata: "broken" }));
    expect(() => f.read()).toThrow("Invalid orchestrator SQLite manifest");
  });

  it("recovers an interrupted review and its coding-run link in one durable write", () => {
    const f = fixture();
    const run = createRun({
      runId: "coding-run",
      sandboxId: "sandbox-one",
      task: "review me",
      repoUrl: "https://github.com/example/repo",
      baseBranch: "main",
      publishPullRequest: false,
    });
    const round: ReviewRound = {
      roundId: "review-one",
      codingRunId: run.runId,
      reviewRunId: "review-run",
      generation: 1,
      pull: {
        owner: "example",
        repo: "repo",
        number: 1,
        headSha: "abc",
        url: "https://github.com/example/repo/pull/1",
      },
      status: "running",
      findings: [],
      summary: "",
      publicationOutcome: "posting",
    };
    f.write({ runs: [run], reviewRounds: [round] });
    let state = f.read() as OrchestratorState;
    let commits = 0;
    new OrchestratorReviews(
      () => state,
      (next) => {
        f.write(next);
        state = next;
        commits++;
      },
    ).recover();
    expect(commits).toBe(1);
    expect(f.read().reviewRounds[0]).toMatchObject({
      status: "failed",
      publicationOutcome: "unknown",
    });
    expect(f.read().runs[0].reviewRoundId).toBe("review-one");
    state = f.read();
    new OrchestratorReviews(
      () => state,
      (next) => {
        f.write(next);
        state = next;
        commits++;
      },
    ).recover();
    expect(commits).toBe(1);
  });

  it("retains the pinned SDK SQL state-row contract", () => {
    const root = dirname(createRequire(import.meta.url).resolve("agents"));
    const source = readdirSync(root)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(root, name), "utf8"))
      .find((source) => source.includes('const STATE_ROW_ID = "cf_state_row_id"'));
    expect(source).toBeDefined();
    expect(source).toMatch(/SELECT state FROM cf_agents_state WHERE id = \$\{STATE_ROW_ID\}/);
    expect(source).toMatch(
      /INSERT OR REPLACE INTO cf_agents_state \(id, state\)\s+VALUES \(\$\{STATE_ROW_ID\}, \$\{JSON.stringify\(nextState\)\}\)/,
    );
  });

  it("round-trips run, approval, Slack, review, session, event and receipt collections across fresh readers", () => {
    const f = fixture();
    const state = {
      runs: [{ runId: "run-one", envSealed: "sealed-env" }],
      pendingApprovals: [{ approvalId: "approval-one" }],
      slackCanvasOrigins: { "approval-one": "slack:team:channel:thread" },
      reviewRounds: [{ roundId: "review-one" }],
      webSessions: [{ id: "session-one" }],
      commandReceipts: { command: { status: "done" } },
      events: [{ seq: 1 }],
      personalExecutionOnly: true,
      sessionDeletedAt: 123,
    };
    f.write(state);
    expect(f.raw().metadata).toEqual({ personalExecutionOnly: true, sessionDeletedAt: 123 });
    expect(JSON.stringify(f.raw())).not.toContain("sealed-env");
    expect(f.read()).toEqual(state);
    const fresh = <T>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) =>
      orchestratorStateSql<T>(
        f.storage,
        strings,
        values,
        (bindings) =>
          [
            ...f.storage.sql.exec(strings.join("?"), ...(bindings as (string | number | null)[])),
          ] as T[],
      );
    const rows = fresh<{
      state: string;
    }>`SELECT state FROM cf_agents_state WHERE id = ${"cf_state_row_id"}`;
    expect(JSON.parse(rows[0]!.state)).toEqual(state);
  });

  it("migrates a legacy snapshot once and preserves explicit empty collections", () => {
    const f = fixture();
    const legacy = {
      runs: [],
      pendingApprovals: [],
      slackCanvasOrigins: {},
      webSessions: [],
      reviewRounds: [],
      tasks: [],
    };
    f.legacy(legacy);
    expect(f.read()).toEqual(legacy);
    expect(f.raw().format).toBe("shiba.orchestrator.sqlite.v1");
    f.write({ ...legacy, runs: [{ runId: "new" }] });
    expect(f.read()).toEqual({ ...legacy, runs: [{ runId: "new" }] });
    f.write(legacy);
    expect(f.read()).toEqual(legacy);
    expect(
      f.database.prepare("SELECT count(*) AS n FROM shiba_orchestrator_collections").get(),
    ).toMatchObject({ n: 0 });
  });

  it("rolls back collection rows and metadata together when a write fails", () => {
    const f = fixture();
    const before = { runs: [{ runId: "original" }], pendingApprovals: [] };
    f.write(before);
    f.database.exec(
      "CREATE TRIGGER reject_approval BEFORE INSERT ON shiba_orchestrator_collections WHEN NEW.collection='pendingApprovals' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() =>
      f.write({ runs: [{ runId: "rejected" }], pendingApprovals: [{ approvalId: "approval" }] }),
    ).toThrow("fixture failure");
    expect(f.read()).toEqual(before);
  });

  it("keeps the legacy source recoverable if migration fails before metadata commits", () => {
    const f = fixture();
    const before = { runs: [{ runId: "original" }] };
    f.legacy(before);
    f.database.exec(
      "CREATE TRIGGER reject_migration BEFORE UPDATE ON cf_agents_state BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() => f.read()).toThrow("fixture failure");
    expect(f.raw()).toEqual(before);
    f.database.exec("DROP TRIGGER reject_migration");
    expect(f.read()).toEqual(before);
  });

  it.each([
    "DELETE FROM shiba_orchestrator_collections",
    "UPDATE shiba_orchestrator_collections SET value = 'not json'",
  ])("fails closed on damaged collection storage: %s", (damage) => {
    const f = fixture();
    f.write({ runs: [{ runId: "retained" }] });
    f.database.exec(damage);
    expect(() => f.read()).toThrow();
    expect(f.raw().format).toBe("shiba.orchestrator.sqlite.v1");
  });

  it("leaves SDK schema-version rows and an absent initial state untouched", () => {
    const f = fixture();
    expect(f.read()).toBeUndefined();
    f.query`INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (${"schema-version"}, ${"23"})`;
    expect(
      f.database.prepare("SELECT state FROM cf_agents_state WHERE id = ?").get("schema-version"),
    ).toMatchObject({ state: "23" });
  });
});
