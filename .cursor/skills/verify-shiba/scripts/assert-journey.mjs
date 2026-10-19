#!/usr/bin/env node
/**
 * Fail loudly when verify-shiba evidence is missing. Reads drive/result.json
 * and live API/stub read-backs.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPort,
  containersMode,
  standinMode,
  readGithubStubState,
  pollCodingRunComplete,
  pollReviewRoundTerminal,
} from "./journey-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const verifyDir = join(root, ".verify");
const driveDir = join(verifyDir, "drive");
const resultPath = join(driveDir, "result.json");

function fail(msg) {
  console.error(`verify-shiba ASSERT: ${msg}`);
  process.exit(1);
}

if (!existsSync(resultPath)) fail("missing .verify/drive/result.json — drive step did not run");

const result = JSON.parse(readFileSync(resultPath, "utf8"));
if (result.error) fail(result.error);

const feature = result.feature ?? process.env.VERIFY_FEATURE ?? "unknown";
const port = readPort();
const assertions = {
  feature,
  githubMode: result.githubMode,
  containersMode: containersMode(),
  standinMode: standinMode(),
  steps: [],
};

function step(name, status, detail) {
  assertions.steps.push({ name, status, detail });
  if (status === "failed") fail(`${name}: ${detail}`);
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const publishFeatures = new Set(["core-loop-mock", "review-findings", "review-lifecycle", "pr-publish"]);
const reviewFeatures = new Set(["core-loop-mock", "review-findings", "review-lifecycle"]);

if (feature === "task-submit-and-approval") {
  step("approval card visible", result.approvalVisible ? "passed" : "failed", "approvalVisible false");
  if (result.rejected) step("reject path", "passed", "rejected without approve");
  writeFileSync(join(driveDir, "assertions.json"), JSON.stringify(assertions, null, 2));
  console.log("verify-shiba assertions ok", feature);
  process.exit(0);
}

if (publishFeatures.has(feature)) {
  if (!result.approvalVisible) step("approval card", "failed", "never appeared");
  else step("approval card", "passed");
  if (!result.approved) step("approve click", "failed", "approve not clicked");
  else step("approve click", "passed");
  if (result.approveApiStatus !== undefined && result.approveApiStatus !== 200) {
    step("POST /api/approvals", "failed", `status ${result.approveApiStatus}`);
  } else if (result.approveApiStatus === 200) {
    step("POST /api/approvals", "passed");
  }

  const runId = result.codingRunId;
  if (!runId) step("coding run id", "failed", "drive did not record codingRunId");
  else step("coding run id", "passed", runId);

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
    if ((stub.pulls?.length ?? 0) < 1) {
      step("mock GitHub PR created", "failed", `pulls=${stub.pulls?.length ?? 0}`);
    } else {
      step("mock GitHub PR created", "passed", stub.pulls[0]?.html_url ?? "pull/1");
    }
    const reviewPosts = (stub.calls ?? []).filter(
      (c) => c.method === "POST" && /\/pulls\/\d+\/reviews$/.test(c.url ?? ""),
    );
    if (reviewFeatures.has(feature)) {
      if (reviewPosts.length < 1) {
        step("reviewer COMMENT posted", "failed", "no POST .../pulls/n/reviews in stub");
      } else {
        step("reviewer COMMENT posted", "passed", `${reviewPosts.length} review(s)`);
      }
    }
  } catch (error) {
    step("mock GitHub stub read-back", "failed", error instanceof Error ? error.message : String(error));
  }

  if (reviewFeatures.has(feature)) {
    let round;
    try {
      round = await pollReviewRoundTerminal(port, runId);
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
    } catch (error) {
      step("review round terminal", "failed", error instanceof Error ? error.message : String(error));
    }
  }

  if (feature === "sandbox-run-and-diff") {
    if (assertions.containersMode === "disabled") {
      step("docker sandbox diff", "skipped", "containers disabled — not a container proof");
    } else if (result.dockerDiffEmpty === false) {
      step("docker sandbox started", "passed", "docker ps changed");
    } else {
      step("docker sandbox started", "failed", "docker ps unchanged after approve");
    }
  }
}

mkdirSync(driveDir, { recursive: true });
writeFileSync(join(driveDir, "assertions.json"), JSON.stringify(assertions, null, 2));
console.log("verify-shiba assertions ok", feature);
