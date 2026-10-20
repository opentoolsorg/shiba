import { describe, expect, it } from "vitest";
import {
  buildStandInCodingResult,
  buildStandInReviewResult,
  formatStandInReviewOutput,
  isReviewerStandIn,
} from "../src/verify-standin.js";
import { parseUnifiedDiff } from "../src/v1/diffs.js";
import { parseReviewEnvelope } from "@shiba/shared";
import type { CodingTaskInput } from "../src/opencode-input.js";

const baseInput: CodingTaskInput = {
  repoUrl: "https://github.com/cloudflare/ai-chat",
  task: "t",
  baseBranch: "main",
  publishPullRequest: true,
  sandboxId: "sb",
  codingModel: "google/gemini-3.5-flash-lite",
};

describe("verify stand-in", () => {
  it("detects reviewer role", () => {
    expect(isReviewerStandIn({ ...baseInput, role: "reviewer" })).toBe(true);
    expect(isReviewerStandIn(baseInput)).toBe(false);
  });

  it("produces diff evidence for coding runs", () => {
    const result = buildStandInCodingResult();
    expect(result.status).toBe("completed");
    const files = parseUnifiedDiff(result.diff);
    expect(files).toEqual([expect.objectContaining({ path: "README.md", additions: 1, deletions: 0 })]);
    expect(result.diff).toContain("@@ -1 +1,2 @@\n # verify-shiba\n+verify-shiba stand-in change\n");
    expect(result.files[0]?.content).toBe("# verify-shiba\nverify-shiba stand-in change\n");
    expect(result.changedFiles.length).toBeGreaterThan(0);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("embeds parseable findings for reviewer output", () => {
    const result = buildStandInReviewResult();
    const text = formatStandInReviewOutput(result);
    const parsed = parseReviewEnvelope(text);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.title).toContain("verify-shiba");
  });
});
