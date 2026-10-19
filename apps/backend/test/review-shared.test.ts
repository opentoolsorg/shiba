import { describe, expect, it } from "vitest";
import {
  blockingRoundForHead,
  parseReviewEnvelope,
  reviewRoundWriteRejected,
  selectPostable,
  type ReviewRound,
} from "@shiba/shared";

const valid = {
  path: "src/app.ts",
  line: 12,
  category: "bug",
  severity: "high",
  confidence: "confirmed",
  title: "Null deref",
  failureScenario: "A missing user crashes the request.",
};

describe("parseReviewEnvelope", () => {
  it("parses a marker envelope and drops invalid findings", () => {
    const raw = `noise\nSHIBA_AI_COWORKER_CODING_RESULT_JSON\n${JSON.stringify({
      summary: "One real bug.",
      findings: [valid, { path: "../etc/passwd", line: 1, title: "x" }, { title: "no path" }],
    })}`;
    const parsed = parseReviewEnvelope(raw);
    expect(parsed.summary).toBe("One real bug.");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.path).toBe("src/app.ts");
    expect(parsed.findings[0]?.triage).toBe("open");
    expect(parsed.findings[0]?.id).toHaveLength(16);
    expect(parsed.rejected).toBe(2);
  });

  it("does not throw on garbage", () => {
    expect(parseReviewEnvelope("not json")).toEqual({ summary: "", findings: [], rejected: 0 });
    expect(parseReviewEnvelope(null).findings).toEqual([]);
  });
});

describe("blockingRoundForHead", () => {
  const round: ReviewRound = {
    roundId: "r1:abc",
    codingRunId: "r1",
    reviewRunId: "rev",
    pull: { owner: "a", repo: "b", number: 1, headSha: "abc", url: "https://github.com/a/b/pull/1" },
    status: "posted",
    findings: [],
    summary: "",
  };

  it("blocks while a round is active or posted", () => {
    expect(blockingRoundForHead([round], "r1", "abc")?.status).toBe("posted");
    expect(blockingRoundForHead([{ ...round, status: "queued" }], "r1", "abc")?.status).toBe("queued");
  });

  it("does not block when the head round failed or was skipped", () => {
    expect(blockingRoundForHead([{ ...round, status: "failed" }], "r1", "abc")).toBeUndefined();
    expect(blockingRoundForHead([{ ...round, status: "skipped" }], "r1", "abc")).toBeUndefined();
  });
});

describe("reviewRoundWriteRejected", () => {
  const posted: ReviewRound = {
    roundId: "r1:abc",
    codingRunId: "r1",
    reviewRunId: "rev",
    pull: { owner: "a", repo: "b", number: 1, headSha: "abc", url: "https://github.com/a/b/pull/1" },
    status: "posted",
    findings: [],
    summary: "",
    generation: 2,
  };

  it("rejects writes with undefined generation over a terminal round", () => {
    expect(reviewRoundWriteRejected(posted, { ...posted, status: "running", generation: undefined })).toBe(true);
  });

  it("rejects stale generations", () => {
    expect(reviewRoundWriteRejected(posted, { ...posted, generation: 1 })).toBe(true);
  });

  it("allows a newer generation", () => {
    expect(reviewRoundWriteRejected(posted, { ...posted, generation: 3 })).toBe(false);
  });
});

describe("selectPostable", () => {
  it("keeps medium and high inline when the threshold is medium", () => {
    const findings = parseReviewEnvelope({
      summary: "",
      findings: [
        { ...valid, severity: "low", title: "nit" },
        { ...valid, severity: "medium", title: "maybe", line: 2 },
        { ...valid, severity: "high", title: "crash", line: 3 },
      ],
    }).findings;
    const selected = selectPostable(findings, "medium");
    expect(selected.inline.map((finding) => finding.severity)).toEqual(["medium", "high"]);
    expect(selected.bodyOnly.map((finding) => finding.severity)).toEqual(["low"]);
  });
});
