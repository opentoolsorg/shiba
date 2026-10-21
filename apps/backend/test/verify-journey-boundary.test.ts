import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scripts = resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts");
const finding = { path: "README.md", line: 2, severity: "medium", title: "finding", failureScenario: "failure" };
const round = { roundId: "round1", codingRunId: "agent-tool:a1", status: "posted", summary: "summary",
  pull: { owner: "cloudflare", repo: "ai-chat", number: 1, headSha: "abc" }, findings: [finding] };
const payload = { event: "COMMENT", commit_id: "abc", body: "summary\n\n<!-- shiba-review-round:round1 -->",
  comments: [{ path: "README.md", line: 2, side: "RIGHT", body: "finding\n\nfailure" }] };

async function exercise(change: string, mode = "mock") {
  const dir = mkdtempSync(join(tmpdir(), "verify-boundary-"));
  mkdirSync(join(dir, "drive"));
  let stubReads = 0;
  const pullUrl = change === "live-correct" ? "https://github.com/cloudflare/ai-chat/pull/1" : "https://github.com/mock/repo/pull/1";
  if (change === "live-correct") {
    // A fixture gh supplies read-only authenticated responses, never real credentials.
    const gh = `#!/usr/bin/env node
const path = process.argv.at(-1);
const pull = { number: 1, html_url: ${JSON.stringify(pullUrl)} };
const review = ${JSON.stringify({ ...payload, id: 42, state: "COMMENTED" })};
console.log(JSON.stringify(path.endsWith('/comments') ? review.comments : path.endsWith('/reviews/42') ? review : pull));
`;
    writeFileSync(join(dir, "gh"), gh, { mode: 0o755 });
  }
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/__shiba/state") {
      stubReads++;
      const body = { ...payload, ...(change === "event" ? { event: "APPROVE" } : {}),
        ...(change === "findings" ? { comments: [] } : {}),
        ...(change === "head" ? { commit_id: "wrong" } : {}),
        ...(change === "round" ? { body: "<!-- shiba-review-round:other -->" } : {}) };
      res.end(JSON.stringify({ pulls: [{ number: 1, html_url: "https://github.com/mock/repo/pull/1" }], calls: [{
        method: "POST", url: `/repos/cloudflare/ai-chat/pulls/${change === "target" ? 99 : 1}/reviews`, body: JSON.stringify(body),
      }] }));
    } else if (req.url?.includes("/pr/review")) res.end(JSON.stringify({ round: { ...round, githubReviewId: 42 } }));
    else res.end(JSON.stringify({ run: { status: "completed", pullUrl } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, "port"), String(port));
  writeFileSync(join(dir, "github-stub-port"), String(port));
  writeFileSync(join(dir, "github-mode"), mode);
  writeFileSync(join(dir, "drive/result.json"), JSON.stringify({
    feature: "core-loop-mock", githubMode: mode, approvalVisible: true, approved: true,
    approveViaApi: true, approveApiStatus: 200, reviewFindingsVisible: true, codingRunId: "agent-tool:a1",
  }));
  try {
    const proc = spawn("node", [join(scripts, "assert-journey.mjs")], {
      env: { ...process.env, VERIFY_DIR: dir, PATH: `${dir}:${process.env.PATH}` }, stdio: "ignore",
    });
    const code = await new Promise<number | null>((done) => proc.on("exit", done));
    return { code, stubReads, assertions: JSON.parse(readFileSync(join(dir, "drive/assertions.json"), "utf8")) };
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); }
}

describe("journey captured GitHub delivery", () => {
  it("accepts the exact COMMENT payload and labels API approval honestly", async () => {
    const out = await exercise("correct");
    expect(out.code).toBe(0);
    expect(out.assertions.steps).toContainEqual(expect.objectContaining({ name: "approve (API)", status: "passed" }));
    expect(out.assertions.steps.some((s: { name: string }) => s.name === "approve click")).toBe(false);
  });
  it.each(["event", "findings", "target", "head", "round"])("rejects wrong %s evidence", async (change) => {
    expect((await exercise(change)).code).toBe(1);
  });
  it("accepts matching authenticated live GET read-backs without accessing the stub", async () => {
    const out = await exercise("live-correct", "live");
    expect(out.code).toBe(0);
    expect(out.stubReads).toBe(0);
    expect(out.assertions.steps).toContainEqual(expect.objectContaining({ name: "live GitHub COMMENT read-back", status: "passed" }));
  });
  it("never consults a stale stub in live mode and refuses unsupported live target proof", async () => {
    const out = await exercise("correct", "live");
    expect(out.stubReads).toBe(0);
    expect(out.code).toBe(1);
    expect(out.assertions.failed).toContain("live GitHub");
  });
});
