import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VMRun } from "../types";
import { DiffView } from "./DiffView";

vi.mock("./ReviewFindings", () => ({
  ReviewFindings: ({ threadId, sessionId }: { threadId: string; sessionId?: string }) => createElement("section", { "data-review-thread": threadId, "data-review-session": sessionId }, "Findings"),
}));

describe("run-specific review findings", () => {
  it("mounts findings for the selected API-created run without any chat messages", () => {
    const runs = ["other", "agent-tool:mine"].map((runId) => ({
      runId, repoUrl: "https://github.com/cloudflare/ai-chat", status: "completed", task: "test",
      createdAt: 1, updatedAt: 1, diff: "", changedFiles: [],
      sandboxId: "test", baseBranch: "main", publishPullRequest: true,
    })) as VMRun[];
    const html = renderToStaticMarkup(createElement(DiffView, { runs, selectedRunId: "agent-tool:mine", sessionId: "named-session" }));
    expect(html).toContain('data-review-thread="agent-tool:mine"');
    expect(html).not.toContain('data-review-thread="other"');
    expect(html).toContain('data-review-session="named-session"');
  });
});
