#!/usr/bin/env node
/**
 * Fail loudly when verify-shiba evidence is missing. Reads drive/result.json
 * and live API/stub read-backs.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  verifyDir,
  readPort,
  containersMode,
  standinMode,
  readGithubStubState,
  pollCodingRunComplete,
  pollReviewRoundTerminal,
  PUBLISH_FEATURES,
  REVIEW_FEATURES,
  SUPPORTED_FEATURES,
} from "./journey-lib.mjs";

const driveDir = join(verifyDir, "drive");
const resultPath = join(driveDir, "result.json");
const assertions = { steps: [] };

function saveAssertions() {
  mkdirSync(driveDir, { recursive: true });
  writeFileSync(join(driveDir, "assertions.json"), JSON.stringify(assertions, null, 2));
}

function fail(msg) {
  console.error(`verify-shiba ASSERT: ${msg}`);
  // Keep the evidence of a failed run — the failing step is the most useful artifact.
  assertions.failed = msg;
  saveAssertions();
  process.exit(1);
}

if (!existsSync(resultPath)) fail("missing .verify/drive/result.json — drive step did not run");

const result = JSON.parse(readFileSync(resultPath, "utf8"));
if (result.error) fail(result.error);

const feature = result.feature ?? process.env.VERIFY_FEATURE ?? "unknown";
const port = readPort();
Object.assign(assertions, {
  feature,
  githubMode: result.githubMode,
  containersMode: containersMode(),
  standinMode: standinMode(),
});

function step(name, status, detail) {
  assertions.steps.push({ name, status, detail });
  if (status === "failed") fail(`${name}: ${detail}`);
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// A feature with no assertions would pass vacuously, so unknown names fail.
if (!SUPPORTED_FEATURES.has(feature)) step("supported feature", "failed", `unknown feature "${feature}"`);

const reportExtra = (name, ok, detail) => step(name, ok ? "passed" : "failed", ok ? undefined : detail);

if (feature === "task-submit-and-approval") {
  reportExtra("approval card visible", result.approvalVisible === true, "approvalVisible not true");
  reportExtra("reject path", result.rejected === true, "reject was never exercised");
  saveAssertions();
  console.log("verify-shiba assertions ok", feature);
  process.exit(0);
}

if (feature === "byo-models-ux") {
  reportExtra("GET /api/model-config", result.modelConfigStatus === 200, `status ${result.modelConfigStatus}`);
  reportExtra("connection test clicked", result.connectionTestClicked === true, "test-connection never clicked");
}
if (feature === "run-registry-status") {
  reportExtra("GET /api/runs", result.runsStatus === 200, `status ${result.runsStatus}`);
}
if (feature === "phase5-integrations-automations") {
  reportExtra("slack verify responded", typeof result.slackVerifyStatus === "number", "no slack verify status");
  reportExtra("github status read", result.githubStatus != null, "githubStatus missing");
}
if (feature === "captain-subagents") {
  reportExtra("captain snapshot", result.captainStatus === 200, `status ${result.captainStatus}`);
  reportExtra("subagent tree visible", result.subagentTreeVisible === true, "subagent-tree not rendered");
}

const approveFeatures = new Set([...PUBLISH_FEATURES, "sandbox-run-and-diff"]);
if (approveFeatures.has(feature)) {
  reportExtra("approval card", result.approvalVisible === true, "never appeared");
  reportExtra("approve click", result.approved === true, "approve not clicked");
  if (result.approveApiStatus !== undefined) {
    reportExtra("POST /api/approvals", result.approveApiStatus === 200, `status ${result.approveApiStatus}`);
  }

  if (REVIEW_FEATURES.has(feature)) {
    reportExtra("review findings visible in UI", result.reviewFindingsVisible === true, "review-findings never rendered");
  }

  const runId = result.codingRunId;
  if (!runId) step("coding run id", "failed", "drive did not record codingRunId");
  else step("coding run id", "passed", runId);

  if (feature === "sandbox-run-and-diff") {
    if (assertions.containersMode === "disabled") {
      step("docker sandbox diff", "skipped", "containers disabled — not a container proof");
    } else {
      // docker ps alone proves nothing: need a completed run with a recorded diff.
      let run;
      try {
        run = await pollCodingRunComplete(port, runId, { requirePull: false });
        step("sandbox run completed", "passed", run.status);
      } catch (error) {
        step("sandbox run completed", "failed", error instanceof Error ? error.message : String(error));
      }
      const hasDiff = typeof run?.diff === "string" && run.diff.includes("diff --git");
      step("sandbox diff recorded", hasDiff ? "passed" : "failed", hasDiff ? undefined : "completed run has no diff");
    }
  }
}

if (PUBLISH_FEATURES.has(feature)) {
  const runId = result.codingRunId;
  let codingRun;
  try {
    codingRun = await pollCodingRunComplete(port, runId);
    step("coding run completed", "passed", codingRun.pullUrl);
  } catch (error) {
    step("coding run completed", "failed", error instanceof Error ? error.message : String(error));
  }

  let stub;
  try {
    stub = await readGithubStubState();
  } catch (error) {
    step("mock GitHub stub read-back", "failed", error instanceof Error ? error.message : String(error));
  }
  if ((stub.pulls?.length ?? 0) < 1) {
    step("mock GitHub PR created", "failed", `pulls=${stub.pulls?.length ?? 0}`);
  } else {
    step("mock GitHub PR created", "passed", stub.pulls[0]?.html_url ?? "pull/1");
  }
  if (REVIEW_FEATURES.has(feature)) {
    const reviewPosts = (stub.calls ?? []).filter(
      (c) => c.method === "POST" && /\/pulls\/\d+\/reviews$/.test(c.url ?? ""),
    );
    if (reviewPosts.length < 1) {
      step("reviewer COMMENT posted", "failed", "no POST .../pulls/n/reviews in stub");
    } else {
      step("reviewer COMMENT posted", "passed", `${reviewPosts.length} review(s)`);
    }
  }
}

if (REVIEW_FEATURES.has(feature)) {
  let round;
  try {
    round = await pollReviewRoundTerminal(port, result.codingRunId);
  } catch (error) {
    step("review round terminal", "failed", error instanceof Error ? error.message : String(error));
  }
  if (round.status !== "posted") {
    step("review round terminal", "failed", `status=${round.status} error=${round.error ?? ""}`);
  } else {
    step("review round terminal", "passed", `status=posted findings=${round.findings?.length ?? 0}`);
  }
  if ((round.findings?.length ?? 0) < 1) {
    step("review findings persisted", "failed", "round has zero findings");
  } else {
    step("review findings persisted", "passed", round.findings[0]?.title ?? "");
  }
}

saveAssertions();
console.log("verify-shiba assertions ok", feature);
