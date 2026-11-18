import type { DelegatedRun } from "@shiba/shared";
import type { CodingTaskInput, CodingTaskResult } from "./opencode-input.js";
import { redactSecrets } from "./security.js";

export function routineCommandFiles(input: CodingTaskInput) {
  if (!input.routineRun) return null;
  const directory = `/tmp/shiba-routine-${encodeURIComponent(input.sandboxId)}`;
  const outcomePath = `${directory}/outcome.json`;
  const contents = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "outcome.json");
const lock = path.join(__dirname, ".lock");
let acquired = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try { fs.mkdirSync(lock); acquired = true; break; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (!acquired) { console.error("Routine outcome is busy."); process.exit(1); }
try {
const outcome = JSON.parse(fs.readFileSync(file, "utf8"));
if (path.basename(__filename) === "routine_no_update") outcome.noUpdate = true;
else {
  const reason = process.argv.slice(2).join(" ").trim();
  if (!reason) throw new Error("A failure reason is required.");
  outcome.failureReason = reason.slice(0, 8192);
}
fs.writeFileSync(file, JSON.stringify(outcome));
} finally { fs.rmdirSync(lock); }
`;
  return { directory, outcomePath, files: [
    { path: `${directory}/routine_no_update`, contents },
    { path: `${directory}/routine_report_failure`, contents },
  ] };
}

export function routineTask(input: CodingTaskInput): CodingTaskInput {
  if (!input.routineRun) return input;
  return { ...input, task: `${input.task}\n\nThis is a routine run. If there is nothing worth notifying the user about, run routine_no_update. To report a failed routine, run routine_report_failure "<reason>" with a specific reason. Failure overrides no-update; test runs are never quiet. Still write your final answer so it remains available in routine history.` };
}

export function parseRoutineOutcome(content: string): NonNullable<CodingTaskResult["routineOutcome"]> {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (!value || typeof value !== "object" || typeof value.noUpdate !== "boolean" ||
      (value.failureReason !== undefined && (typeof value.failureReason !== "string" || !value.failureReason.trim()))) {
    throw new Error("Invalid routine outcome.");
  }
  return { noUpdate: value.noUpdate,
    ...(typeof value.failureReason === "string" ? { failureReason: redactSecrets(value.failureReason).slice(0, 500) } : {}) };
}

export function isQuietRoutine(run: Pick<DelegatedRun, "routineRun" | "routineOutcome" | "status">): boolean {
  return Boolean(run.routineRun && !run.routineRun.test && run.status === "completed" &&
    run.routineOutcome?.noUpdate && !run.routineOutcome.failureReason);
}

export function routineIdentity(intake: string | null): DelegatedRun["routineRun"] {
  const match = /^routine:([^:]+):(test|scheduled)$/.exec(intake ?? "");
  if (!match) return undefined;
  try { return { automationId: decodeURIComponent(match[1]!), test: match[2] === "test" }; }
  catch { return undefined; }
}
