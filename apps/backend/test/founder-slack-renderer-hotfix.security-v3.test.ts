import { describe, expect, it } from "vitest";
import { assertAutomaticSlackFamilyCode, renderAutomaticSlackCompactReport, renderAutomaticSlackReport, renderAutomaticSlackSource, type AutomaticSlackRow } from "../src/founder-automatic-slack-store.js";
import type { AutomaticReportAuthority } from "../src/founder-auto-read-runtime.js";
import { founderConnectorRecipeHash } from "../src/founder-connector-context.js";
import { hashToolArgs } from "../src/mcp-gateway.js";
import { AUTOMATIC_SLACK_AUDIENCE_CONSENT, REPORT_SLACK_MAX_BYTES } from "@shiba/shared";

const notice = "Fixed reads under an explicit standing grant. Captures are bounded; dataset completeness is unknown and business success is unverified. No model, inferred metrics, MRR, churn or freshness claim.";
const report = () => ({ format: "shiba.automatic-read.report.v1", notice, sourceProof: { retained: "all extra provenance" }, sources: [{ sourceKind: "standing-scheduled-read", datasetCompleteness: "unknown", businessSuccess: "unverified", operationId: "github.list_pull_requests", connectionId: "source-one", connectionVersion: 1, arguments: { limit: 1 }, inputSchemaHash: "schema", executorHash: "executor", queryHash: null, capturedAt: 100, capturedBytes: 120, state: "completed", requestDigest: "request", resultDigest: "result", captureCompleteness: "bounded-response", result: { rows: [{ title: "Untrusted <@U1> & <https://evil.test>" }] }, error: null }] });
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const row = (renderPolicy: string) => ({ family_json: JSON.stringify({ renderPolicy }) }) as AutomaticSlackRow;
const source = (markdown: string, wire = json(report())) => ({ markdown, json: wire }) as AutomaticReportAuthority["report"];

describe("independent v3 versioned complete Slack renderer hotfix", () => {
  it("rejects replacing a known reviewed v1 renderer with known v2 without a new frozen digest", async () => {
    const family = { renderPolicy: "complete-qualified-markdown.v1", recipeHash: await founderConnectorRecipeHash("founder-figma-ticket") };
    const frozen = { library_id: "founder-figma-ticket", family_json: JSON.stringify(family), digest: "", used_sends: 0, state: "draft", approved_at: null, approver_json: null, error_code: null } as AutomaticSlackRow;
    frozen.digest = await hashToolArgs({ ...frozen, digest: undefined, renderPolicy: family.renderPolicy, maxBytes: REPORT_SLACK_MAX_BYTES, futureAudience: AUTOMATIC_SLACK_AUDIENCE_CONSENT });
    await expect(assertAutomaticSlackFamilyCode(frozen)).resolves.toBeUndefined();
    await expect(assertAutomaticSlackFamilyCode({ ...frozen, state: "enabled", used_sends: 1, approved_at: 1, approver_json: "{}" })).resolves.toBeUndefined();
    await expect(assertAutomaticSlackFamilyCode({ ...frozen, family_json: JSON.stringify({ ...family, renderPolicy: "complete-qualified-compact-json.v2" }) })).rejects.toThrow("automatic_slack_contract_changed");
  });
  it("preserves all canonical report fields and values, with escaped mentions and full qualifications", () => {
    const original = report(), content = renderAutomaticSlackCompactReport(json(original));
    expect(content).toContain("dataset completeness is unknown and business success is unverified");
    expect(content).not.toContain("<@U1>");
    const compact = content.slice(content.indexOf("\n\n") + 2).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    expect(JSON.parse(compact)).toEqual(original);
  });
  it("retains legacy Markdown bytes and rejects oversized v1 even when v2 fits", () => {
    const small = source("Original complete Markdown");
    expect(renderAutomaticSlackSource(row("complete-qualified-markdown.v1"), small)).toBe(renderAutomaticSlackReport(small.markdown));
    const large = source("x".repeat(3500));
    expect(() => renderAutomaticSlackSource(row("complete-qualified-markdown.v1"), large)).toThrow("automatic_slack_complete_report_too_large");
    expect(renderAutomaticSlackSource(row("complete-qualified-compact-json.v2"), large)).toBe(renderAutomaticSlackCompactReport(large.json));
    expect(() => renderAutomaticSlackSource(row("complete-qualified-compact-json.v3"), small)).toThrow();
  });
  it("rejects duplicate-key JSON, missing qualifications and missing source provenance", () => {
    const wire = json(report());
    expect(() => renderAutomaticSlackCompactReport(wire.replace('  "notice":', '  "notice": "discarded",\n  "notice":'))).toThrow();
    const missing = report(); delete (missing.sources[0] as unknown as Record<string, unknown>).resultDigest;
    expect(() => renderAutomaticSlackCompactReport(json(missing))).toThrow();
    expect(() => renderAutomaticSlackCompactReport(json({ ...report(), notice: "Complete business success" }))).toThrow();
  });
  it("enforces the original UTF-8 cap after escaping without silently truncating", () => {
    for (const title of ["x".repeat(3500), "😀".repeat(900), "&".repeat(700)]) {
      const original = report(); original.sources[0]!.result.rows[0]!.title = title;
      expect(() => renderAutomaticSlackCompactReport(json(original))).toThrow("automatic_slack_complete_report_too_large");
    }
  });
});
