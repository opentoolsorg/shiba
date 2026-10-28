import { describe, expect, it, vi } from "vitest";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
vi.mock("../src/slack-routes.js", () => ({ ORCHESTRATOR_NAME: "default" }));

import { Automations, type AutomationsState, type OrchestratorStub } from "../src/automations-do.js";
import { createAutomation, type Automation } from "../src/automations.js";
import type { Env } from "../src/env.js";

class FakeStorage {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async transaction<T>(callback: (transaction: FakeStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const NOW = Date.UTC(2026, 9, 28, 10, 0);
const REPO = "https://github.com/owner/repo";

function makeDo(items: Automation[]) {
  const storage = new FakeStorage();
  storage.data.set("state", { items });
  const env = {
    AUTOMATIONS_ENABLED: "true",
    AI: {},
    ORCHESTRATOR_MODEL: "@cf/test/model",
  } as unknown as Env;
  const automation = new Automations({ storage } as unknown as DurableObjectState, env);
  const fetch = vi.fn(async () => Response.json({ approvalId: "pending-approval" }));
  const orchestrator: OrchestratorStub = { fetch };
  return { automation, storage, orchestrator, fetch };
}

function addDueBatch(storage: FakeStorage, id: string) {
  storage.data.set(`webhook-batch:${id}`, {
    bodies: ['{"issue":"fix this"}'],
    firstAt: NOW - 60_000,
    windowSeconds: 10,
  });
}

describe("automation tick webhook and schedule state", () => {
  it("charges a flushed webhook against the daily budget before evaluating schedules", async () => {
    const item: Automation = {
      ...createAutomation({
        id: "combined",
        prompt: "Triage",
        repoUrl: REPO,
        triggers: [
          { kind: "webhook", batchWindowSeconds: 10 },
          { kind: "schedule", cron: "0 * * * *" },
        ],
      }).automation,
      dailyRunLimit: 1,
      // This schedule has its own prior firing; a webhook firing must not
      // overwrite that cursor or erase the shared daily run charge.
      scheduleFiredAt: { t1: NOW - 3_600_000 },
    };
    const { automation, storage, orchestrator, fetch } = makeDo([item]);
    addDueBatch(storage, item.id);

    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = (await storage.get<AutomationsState>("state"))?.items[0];
    expect(saved?.runCount).toBe(1);
    expect(saved?.runsToday).toBe(1);
    expect(saved?.lastSkip?.reason).toContain("Daily run budget");
    expect(saved?.scheduleFiredAt).toEqual(item.scheduleFiredAt);
  });

  it("preserves a webhook's durable counters when another automation's schedule fires", async () => {
    const webhook = createAutomation({
      id: "webhook",
      prompt: "Triage",
      repoUrl: REPO,
      triggers: [{ kind: "webhook", batchWindowSeconds: 10 }],
    }).automation;
    const schedule = createAutomation({
      id: "scheduled",
      prompt: "Check repository",
      repoUrl: REPO,
      triggers: [{ kind: "schedule", cron: "0 * * * *" }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([webhook, schedule]);
    addDueBatch(storage, webhook.id);

    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const state = await storage.get<AutomationsState>("state");
    expect(state?.items.map(({ id, runCount, runsToday }) => ({ id, runCount, runsToday }))).toEqual([
      { id: "webhook", runCount: 1, runsToday: 1 },
      { id: "scheduled", runCount: 1, runsToday: 1 },
    ]);

    // The persisted cursors must also survive the next cron invocation.
    expect(await automation.tick(orchestrator, NOW + 60_000)).toEqual({ fired: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
