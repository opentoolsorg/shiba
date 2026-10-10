// T64 + REVIEW3 F13: the poller seeds silently once, and `seen` survives
// stop/start so approvals queued while suspended still notify on resume.
import { expect, it, vi } from "vitest";
import { createApprovalsPoller } from "../src/approvals-poller.js";
import type { ApprovalLike, ApprovalsPollerDeps } from "../src/approvals-poller.js";

function makeDeps(queue: ApprovalLike[][], notified: string[]) {
  const intervals: Array<() => void> = [];
  const deps: ApprovalsPollerDeps = {
    fetch: async () => ({
      status: 200,
      json: async () => ({ approvals: queue.length ? queue.shift()! : [] }),
    }),
    approvalsUrl: "https://shiba.example.com/api/approvals",
    openUrl: "https://shiba.example.com/app/?tab=approvals",
    showWindow: () => undefined,
    loadURL: () => undefined,
    notify: (n) => {
      notified.push(`${n.title}:${n.body}`);
    },
    setIntervalFn: ((fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
  };
  return { deps, intervals };
}

const a = (id: string, repo = "https://github.com/o/r"): ApprovalLike => ({ approvalId: id, repoUrl: repo });

it("seeds silently on first start, then notifies on new approvals", async () => {
  const notified: string[] = [];
  const { deps, intervals } = makeDeps(
    [[a("a1")], [a("a1"), a("a2", "https://github.com/o/r2")]],
    notified,
  );
  const poller = createApprovalsPoller(deps);
  expect(await poller.start()).toBe(true);
  expect(notified).toHaveLength(0);
  intervals.at(-1)!();
  await vi.waitFor(() => expect(notified).toEqual(["Approval needed:o/r2"]));
});

it("does not re-seed on restart — approvals queued while stopped notify on resume (F13)", async () => {
  const notified: string[] = [];
  const { deps } = makeDeps(
    [[a("a1")], [a("a1"), a("a2", "https://github.com/o/r2")]],
    notified,
  );
  const poller = createApprovalsPoller(deps);
  expect(await poller.start()).toBe(true);
  poller.stop();
  // a2 arrived while the poller was stopped (e.g. the machine was suspended).
  expect(await poller.start()).toBe(true);
  expect(notified).toEqual(["Approval needed:o/r2"]);
});

it("stays off when the endpoint does not return 200", async () => {
  const notified: string[] = [];
  const deps: ApprovalsPollerDeps = {
    fetch: async () => ({ status: 404, json: async () => ({}) }),
    approvalsUrl: "https://shiba.example.com/api/approvals",
    openUrl: "https://shiba.example.com/app/?tab=approvals",
    showWindow: () => undefined,
    loadURL: () => undefined,
    notify: (n) => {
      notified.push(n.title);
    },
  };
  const poller = createApprovalsPoller(deps);
  expect(await poller.start()).toBe(false);
  expect(poller.isRunning()).toBe(false);
});

it("overlapping start() calls share one fetch and leave one interval", async () => {
  const { deps, intervals } = makeDeps([[a("a1")]], []);
  const poller = createApprovalsPoller(deps);
  const [r1, r2] = await Promise.all([poller.start(), poller.start()]);
  expect([r1, r2]).toEqual([true, true]);
  expect(intervals).toHaveLength(1);
});

it("stop() during an in-flight start() wins", async () => {
  const { deps, intervals } = makeDeps([[a("a1")]], []);
  const poller = createApprovalsPoller(deps);
  const pending = poller.start();
  poller.stop();
  expect(await pending).toBe(false);
  expect(poller.isRunning()).toBe(false);
  expect(intervals).toHaveLength(0);
});
