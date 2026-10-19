#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const verifyDir = join(root, ".verify");

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

export async function pollCodingRunComplete(port, runId) {
  return waitFor(`coding run ${runId} completed`, async () => {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    const run = res.body?.run ?? res.body;
    if (run?.status === "completed" && run.pullUrl) return run;
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
