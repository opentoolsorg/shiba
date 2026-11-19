import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleLearning } from "../src/learning-routes.js";
import { listLearningCheckIns, sweepLearningCheckIns } from "../src/ports/learning/check-ins.js";
import { d1LearningPort } from "../src/ports/learning/d1-adapter.js";
import { learningTurnText } from "../src/ports/learning/review.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const morning = Date.UTC(2026, 10, 19);
const halfDay = 43_200_000;
const path = "/api/learning/check-ins";
const workspaceId = "self-hosted";
const ownerId = "alice@example.test";

function harness(routines: string[] = []) {
  const { database } = customAgentD1();
  const readRoutines = vi.fn(async (_url: string) => Response.json({
    automations: routines.map((prompt) => ({ prompt })),
  }));
  const env = {
    AGENT_AUDIT: database,
    Automations: { idFromName: vi.fn(), get: () => ({ fetch: readRoutines }) },
  } as unknown as Env;
  const port = d1LearningPort(database);
  async function record(task: string, periods = [3, 1], owner = ownerId, workspace = workspaceId) {
    for (const period of periods) {
      await port.recordTurn({
        threadKey: `${workspace}:${owner}:${task}`,
        orgId: workspace,
        workspaceId: workspace,
        ownerId: owner,
        employeeId: "default",
      }, {
        runId: crypto.randomUUID(),
        text: learningTurnText(task, "Task completed."),
        completedAt: morning - period * halfDay,
      });
    }
  }
  const list = (owner = ownerId, workspace = workspaceId) => listLearningCheckIns(database, workspace, owner);
  const sweep = (when = morning) => sweepLearningCheckIns(env, when);
  const request = (suffix = "", method = "GET", owner = ownerId, origin = "http://localhost") =>
    handleLearning(new Request(`http://localhost${path}${suffix}`, {
      method,
      headers: { Origin: origin, "CF-Access-Authenticated-User-Email": owner },
    }), env);
  return { record, list, sweep, request, port, readRoutines };
}

describe("scheduled learning check-ins", () => {
  it("offers two distinct repeated tasks per UTC day at most, even on concurrent delivery", async () => {
    const h = harness(["  CHECK THE OPEN INVOICES FOR OVERDUE ITEMS  "]);
    await h.record("Check the open invoices for overdue items");
    const tasks = [
      "Collect open questions from the onboarding guide",
      "Review the weekly support ticket backlog",
      "Summarize changes in the product handbook",
    ];
    for (const task of tasks) await h.record(task);
    await h.record("Compile the latest monthly budget figures", [1.2, 1]);

    await h.sweep(morning + 300_000);
    expect(await h.list()).toEqual([]);
    expect(h.readRoutines).not.toHaveBeenCalled();
    await Promise.all([h.sweep(), h.sweep()]);
    expect((await h.list()).map((row) => row.task)).toEqual([tasks[0]]);
    await h.sweep(morning + halfDay);
    const rows = await h.list();
    expect(rows.map((row) => row.task)).toEqual([tasks[1], tasks[0]]);
    expect(h.readRoutines.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ["https://internal/api/automations"]),
    );
  });

  it("keeps dismissals private, rejects apply and cross-origin writes, and never resurfaces the same task", async () => {
    const h = harness();
    const task = "Review the weekly support ticket backlog";
    await h.record(task);
    await h.sweep();
    const result = await h.request();
    if (!result?.ok) throw new Error("Check-ins could not be read");
    const { checkIns: [proposal] } = await result.json() as { checkIns: { id: string; task: string }[] };
    if (!proposal) throw new Error("Expected a check-in");
    expect(proposal.task).toBe(task);
    expect(await h.list(ownerId, "team:other")).toEqual([]);
    expect(await h.list("bob@example.test")).toEqual([]);
    const id = proposal.id;
    expect((await h.request(`/${id}/apply`, "POST"))?.status).toBe(405);
    expect((await h.request(`/${id}/dismiss`, "POST", "bob@example.test"))?.status).toBe(404);
    expect((await h.request(`/${id}/dismiss`, "POST", ownerId, "https://other.test"))?.status).toBe(403);
    expect((await h.request(`/${id}/dismiss`, "POST"))?.status).toBe(200);
    expect((await h.request(`/${id}/dismiss`, "POST"))?.status).toBe(200);
    await h.record(task.toUpperCase());
    await h.sweep(morning + halfDay);
    expect(await h.list()).toEqual([]);
  });

  it("backs off without recent repeat evidence or when learning is off", async () => {
    const h = harness();
    await h.record("Review the weekly support ticket backlog", [20, 19]);
    await h.record("Check the open invoices for overdue items", [1.3, 1.1]);
    await h.sweep();
    expect(await h.list()).toEqual([]);
    await h.record("Summarize changes in the product handbook");
    await h.port.setSetting(workspaceId, "off", morning);
    await h.sweep(morning + halfDay);
    expect(await h.list()).toEqual([]);
    expect(h.readRoutines).not.toHaveBeenCalled();
  });
});
