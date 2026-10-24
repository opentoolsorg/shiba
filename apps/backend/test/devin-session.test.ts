import { describe, expect, it, vi } from "vitest";
import { runDevinSessionWorkflow } from "../src/devin-session/workflow.js";

describe("devin session workflow", () => {
  it("creates a session, polls to completion, and extracts a PR URL", async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions") && !url.includes("/sessions/")) {
        return Response.json({
          session_id: "devin-abc",
          url: "https://app.devin.ai/sessions/devin-abc",
          status: "running",
        });
      }
      if (url.includes("/sessions/devin-abc") && !url.endsWith("/messages")) {
        polls++;
        return Response.json({ status: polls < 2 ? "running" : "completed" });
      }
      if (url.endsWith("/messages")) {
        return Response.json({
          messages: [{ text: "Opened https://github.com/acme/widgets/pull/42 for review." }],
        });
      }
      return new Response("", { status: 404 });
    });

    const result = await runDevinSessionWorkflow({
      apiKey: "cog_test",
      orgId: "org-1",
      prompt: "Fix the bug",
      repoUrl: "https://github.com/acme/widgets",
      fetchImpl: fetchImpl as typeof fetch,
      pollIntervalMs: 1,
      maxPolls: 5,
    });

    expect(result.sessionId).toBe("devin-abc");
    expect(result.status).toBe("completed");
    expect(result.pullRequestUrl).toBe("https://github.com/acme/widgets/pull/42");
  });
});
