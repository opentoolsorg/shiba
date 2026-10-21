#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
// VERIFY_DIR lets regression tests point the scripts at a temp evidence dir.
export const verifyDir = process.env.VERIFY_DIR || join(root, ".verify");

export function readPort() {
  return existsSync(join(verifyDir, "port"))
    ? readFileSync(join(verifyDir, "port"), "utf8").trim()
    : process.env.PORT || "8788";
}

export function readStubPort() {
  return existsSync(join(verifyDir, "github-stub-port"))
    ? readFileSync(join(verifyDir, "github-stub-port"), "utf8").trim()
    : process.env.GITHUB_STUB_PORT || "8799";
}

export function containersMode() {
  const raw = existsSync(join(verifyDir, "containers-mode"))
    ? readFileSync(join(verifyDir, "containers-mode"), "utf8").trim()
    : "unknown";
  if (raw === "disabled" || raw.startsWith("containers=disabled")) return "disabled";
  if (raw.startsWith("containers=enabled")) return "enabled";
  return raw;
}

export function standinMode() {
  return existsSync(join(verifyDir, "standin-mode"))
    ? readFileSync(join(verifyDir, "standin-mode"), "utf8").trim()
    : process.env.VERIFY_STANDIN || "unknown";
}

export async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body, text };
}

export async function readGithubStubState() {
  const stubPort = readStubPort();
  const res = await fetchJson(`http://127.0.0.1:${stubPort}/__shiba/state`);
  if (!res.ok) {
    throw new Error(`github stub state failed: ${res.status} ${res.text}`);
  }
  return res.body;
}

export async function waitFor(
  label,
  predicate,
  { timeoutMs = 180_000, intervalMs = 2000 } = {},
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

export const PUBLISH_FEATURES = new Set(["core-loop-mock", "review-findings", "review-lifecycle", "pr-publish"]);
export const REVIEW_FEATURES = new Set(["core-loop-mock", "review-findings", "review-lifecycle"]);
export const APPROVE_FEATURES = new Set([...PUBLISH_FEATURES, "sandbox-run-and-diff"]);
export const SUPPORTED_FEATURES = new Set([
  ...APPROVE_FEATURES,
  "task-submit-and-approval",
  "byo-models-ux",
  "run-registry-status",
  "phase5-integrations-automations",
  "captain-subagents",
]);

// Runs minted from an approval are keyed agent-tool:<approvalId>.
export const runIdForApproval = (approvalId) => `agent-tool:${approvalId}`;

// Newest pending approval whose task is this verify run's, so stale cards from other runs are ignored.
export function pickVerifyApproval(approvals, knownIds = []) {
  const known = new Set(knownIds);
  return (approvals ?? [])
    .filter((a) => String(a.task ?? "").startsWith("verify-shiba:") && !known.has(a.approvalId))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

export async function pollCodingRunComplete(port, runId, { requirePull = true } = {}) {
  return waitFor(`coding run ${runId} completed`, async () => {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    const run = res.body?.run ?? res.body;
    if (run?.status === "completed" && (!requirePull || run.pullUrl)) return run;
    if (run?.status === "error" || run?.status === "unknown") {
      throw new Error(`coding run terminal ${run.status}: ${run.error ?? "no detail"}`);
    }
    return null;
  });
}

export async function pollReviewRoundTerminal(port, threadId) {
  return waitFor(`review round for ${threadId}`, async () => {
    const res = await fetchJson(
      `http://127.0.0.1:${port}/api/v1/threads/${encodeURIComponent(threadId)}/pr/review`,
    );
    if (!res.ok) return null;
    const round = res.body?.round;
    if (!round) return null;
    if (round.status === "posted" || round.status === "failed" || round.status === "skipped") {
      return round;
    }
    return null;
  });
}

export function githubMode() {
  return existsSync(join(verifyDir, "github-mode"))
    ? readFileSync(join(verifyDir, "github-mode"), "utf8").trim()
    : "unknown";
}

// Check actual delivery, not the stub's unconditional COMMENTED response. Findings
// may be inline or in the body, depending on REVIEW_INLINE_THRESHOLD.
export function reviewPayloadMatches(round, payload) {
  if (payload?.event !== "COMMENT" || payload.commit_id !== round.pull.headSha ||
      !payload.body?.includes(`<!-- shiba-review-round:${round.roundId} -->`)) return false;
  return (round.findings ?? []).length > 0 && round.findings.every((finding) =>
    (payload.comments ?? []).some((comment) =>
      comment.path === finding.path && comment.line === finding.line && comment.side === "RIGHT" &&
      comment.body === `${finding.title}\n\n${finding.failureScenario}`) ||
    payload.body.includes(`- ${finding.severity} ${finding.path}:${finding.line} ${finding.title}`),
  );
}

// gh supplies its own authenticated session; no token is read, logged or written
// into evidence. Fixed hostname + GET-only routes prevent mock/live crossover.
export async function readLiveGithub(path) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("gh", ["api", "--hostname", "github.com", "--method", "GET", path],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
