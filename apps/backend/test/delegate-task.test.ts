import { describe, expect, it, vi } from "vitest";
import { createDelegateTaskTool } from "../src/agents/specialists/delegate-task.js";
import { exploreInputSchema, reviewInputSchema } from "../src/agents/specialists/contract.js";

const options = { toolCallId: "compat-child", messages: [], context: {} };

function host() {
  const explorer = vi.fn(async () => ({ agent: "explorer", status: "completed", summary: "Inspected snapshot." }));
  const reviewer = vi.fn(async () => ({ agent: "reviewer", status: "completed", summary: "Audited diff." }));
  const queue = vi.fn(async (_input: unknown) => Response.json({ approvalId: "human-pending" }));
  const persist = vi.fn();
  const budget = { remaining: 3, active: 0 };
  const tool = createDelegateTaskTool({ explore_codebase: { inputSchema: exploreInputSchema, execute: explorer }, review_diff: { inputSchema: reviewInputSchema, execute: reviewer } }, budget, queue, persist);
  return { tool, explorer, reviewer, queue, persist, budget };
}

describe("bounded delegate_task compatibility", () => {
  it("sends only explicitly supplied researcher snapshot and context", async () => {
    const h = host();
    const context = { files: [{ path: "a.ts", content: "export const a = 1;" }], context: "Inspect this file." };
    await h.tool.execute?.({ agent: "researcher", goal: "Find a", context }, options);
    expect(h.explorer).toHaveBeenCalledWith({ goal: "Find a", ...context }, options);
    expect(h.reviewer).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled();
  });

  it("maps analyst to the bounded read-only diff reviewer", async () => {
    const h = host();
    await h.tool.execute?.({ agent: "analyst", goal: "Audit", context: { specification: "Keep gates", diff: "+change" } }, options);
    expect(h.reviewer).toHaveBeenCalledWith({ goal: "Audit", context: "", specification: "Keep gates", diff: "+change" }, options);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it.each(["researcher", "analyst", "coder"] as const)("returns a structured missing-context observation for %s", async (agent) => {
    const h = host();
    await expect(h.tool.execute?.({ agent, goal: "Do the task", context: "Use your prior conversation." }, options)).resolves.toMatchObject({ agent, status: "invalid_context" });
    expect(h.explorer).not.toHaveBeenCalled(); expect(h.reviewer).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled();
  });

  it("queues coder work as a fresh human decision using only the explicit target and context", async () => {
    const h = host();
    const result = await h.tool.execute?.({ agent: "coder", goal: "Fix source", context: { repoUrl: "https://github.com/o/r", context: "Preserve approval checks." } }, options);
    expect(result).toMatchObject({ agent: "coder", status: "awaiting_approval", result: { approvalId: "human-pending" } });
    expect(h.queue).toHaveBeenCalledWith({ repoUrl: "https://github.com/o/r", baseBranch: "main", task: "Fix source\n\nPreserve approval checks." });
    expect(h.budget).toEqual({ remaining: 2, active: 0 });
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.explorer).not.toHaveBeenCalled(); expect(h.reviewer).not.toHaveBeenCalled();
  });

  it("refuses autonomous approval, publication fields and exhausted coder capacity", async () => {
    const h = host();
    const input = { agent: "coder" as const, goal: "Change source", context: { repoUrl: "https://github.com/o/r", approved: true, publishPullRequest: true } };
    await expect(h.tool.execute?.(input, options)).resolves.toMatchObject({ status: "invalid_context" });
    h.budget.remaining = 0;
    await expect(h.tool.execute?.({ ...input, context: { repoUrl: "https://github.com/o/r" } }, options)).resolves.toMatchObject({ status: "capacity_reached" });
    expect(h.queue).not.toHaveBeenCalled();
  });
});
