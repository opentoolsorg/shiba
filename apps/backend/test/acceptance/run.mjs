import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const planPath = path.join(scriptDir, "journeys.json");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const runId = new Date().toISOString().replaceAll(":", "-");
const outputDir = path.join(tmpdir(), "shiba-e2e-acceptance");
mkdirSync(outputDir, { recursive: true });

const filesByApp = {
  backend: plan.journeys.flatMap((journey) => journey.tests ?? []).filter((test) => test.startsWith("apps/backend/")).map((test) => path.relative(path.join(repoRoot, "apps/backend"), path.join(repoRoot, test))),
  frontend: plan.journeys.flatMap((journey) => journey.tests ?? []).filter((test) => test.startsWith("apps/frontend/")).map((test) => path.relative(path.join(repoRoot, "apps/frontend"), path.join(repoRoot, test))),
};

for (const app of Object.keys(filesByApp)) {
  filesByApp[app] = [...new Set(filesByApp[app])];
}

const appResults = {};
let failed = false;
for (const [app, files] of Object.entries(filesByApp)) {
  if (files.length === 0) continue;
  const appRoot = path.join(repoRoot, "apps", app);
  const reportPath = path.join(outputDir, `${runId}-${app}.json`);
  const args = ["exec", "vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, ...files];
  const result = spawnSync("pnpm", args, { cwd: appRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = null;
  }
  const testFiles = new Map((report?.testResults ?? []).map((item) => [
    path.resolve(appRoot, item.name),
    item.status === "passed" ? "passed" : "failed",
  ]));
  appResults[app] = { exitCode: result.status, signal: result.signal ?? null, reportPath, testFiles: Object.fromEntries(testFiles) };
  if (result.status !== 0 || result.error) failed = true;
}

const journeys = plan.journeys.map((journey) => {
  if (journey.status === "blocked") return { ...journey, status: "blocked" };
  const testResults = (journey.tests ?? []).map((test) => {
    const app = test.startsWith("apps/backend/") ? "backend" : "frontend";
    const absolute = path.resolve(repoRoot, test);
    const status = appResults[app]?.testFiles?.[absolute] ?? "not_run";
    return { path: test, status };
  });
  const status = testResults.every((test) => test.status === "passed") ? "passed" :
    testResults.some((test) => test.status === "failed") ? "failed" : "not_run";
  if (status !== "passed") failed = true;
  return { ...journey, status, testResults };
});

const evidence = {
  ...plan,
  runId,
  executedAt: new Date().toISOString(),
  sourceRevision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(),
  dirtyHarnessChangesIncluded: true,
  result: failed ? "failed" : "passed_with_blockers",
  journeys,
};
const latestPath = path.join(scriptDir, "evidence.latest.json");
writeFileSync(latestPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nAcceptance evidence: ${path.relative(repoRoot, latestPath)}`);
for (const journey of journeys) console.log(`${journey.status.toUpperCase().padEnd(8)} ${journey.id}`);
process.exitCode = failed ? 1 : 0;
