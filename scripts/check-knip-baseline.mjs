import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const knip = fileURLToPath(new URL("node_modules/knip/bin/knip.js", root));
const { issues } = JSON.parse(execFileSync(process.execPath, [
  knip, "--reporter", "json",
], { cwd: root, encoding: "utf8" }));

const current = new Set(issues.flatMap(({ file, ...groups }) =>
  Object.entries(groups).flatMap(([kind, findings]) =>
    findings.map(({ name }) => JSON.stringify([kind, file.replaceAll("\\", "/"), name])),
  ),
));

if (process.argv.includes("--list")) {
  console.log([...current].sort().join("\n"));
} else {
  const baseline = new Set(readFileSync(new URL("knip-baseline.jsonl", root), "utf8").trim().split(/\r?\n/).filter(Boolean));
  const added = [...current].filter((finding) => !baseline.has(finding)).sort();
  const removed = [...baseline].filter((finding) => !current.has(finding)).sort();
  if (added.length) console.error("New Knip findings:\n" + added.join("\n"));
  if (removed.length) console.error("Remove these resolved findings from knip-baseline.jsonl:\n" + removed.join("\n"));
  if (added.length || removed.length) process.exitCode = 1;
  else console.log(`Knip: no new findings (${baseline.size} known).`);
}
