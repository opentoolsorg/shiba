import { describe, expect, it } from "vitest";
import {
  buildStandInCodingResult,
  buildStandInReviewResult,
  formatStandInReviewOutput,
  isReviewerStandIn,
} from "../src/verify-standin.js";
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
