import { describe, expect, it } from "vitest";
import { parseReviewEnvelope, selectPostable } from "@shiba/shared";

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
