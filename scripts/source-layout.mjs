import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repo, "apps/backend/src");
const outputPath = path.join(repo, "docs/SOURCE-LAYOUT.md");
const domains = ["workspace", "employee", "thread/collaboration", "run", "approval", "channels", "connectors", "sandbox", "model", "founder", "platform"];

const overrides = new Map([
  ["index.ts", "platform"],
  ["agents/orchestrator.ts", "run"],
  ["agents/orchestrator-projections.ts", "run"],
  ["routes/table.ts", "platform"],
]);

function filesUnder(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(absolute, relative) : [relative];
  });
}

function classify(relative, source) {
  if (overrides.has(relative)) return overrides.get(relative);
  if (relative.startsWith("founder/") || path.basename(relative).startsWith("founder-")) return "founder";
  const name = path.basename(relative).toLowerCase();
  const text = `${name} ${source.slice(0, 1200).toLowerCase()}`;
  if (/workspace|team-work|org-/.test(name)) return "workspace";
  if (/employee|skill-library|custom-agent/.test(name)) return "employee";
  if (/collab|thread|conversation-room/.test(name)) return "thread/collaboration";
  if (/approval|pending-approval/.test(name)) return "approval";
  if (/slack|gmail|email|telegram|discord|channel/.test(name)) return "channels";
  if (/connector|integration|oauth|mcp|webhook/.test(name)) return "connectors";
  if (/sandbox|local-dispatch|computer|container/.test(name)) return "sandbox";
  if (/model|harness|provider|credential/.test(name)) return "model";
  if (/run|task|runtime|orchestrat/.test(name)) return "run";
  if (/founder/.test(text)) return "founder";
  return "platform";
}

const files = filesUnder(sourceRoot).sort();
const grouped = new Map(domains.map((domain) => [domain, []]));
for (const relative of files) {
  const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
  const domain = classify(relative, source);
  grouped.get(domain).push(relative);
}

const content = [
  "# Backend source layout",
  "",
  "Domain ownership map for `apps/backend/src`. Generated from current filenames and import context, then corrected with explicit assignments for the main router and orchestrator. Founder source implementations live in `founder/`; root re-export files remain for imports held by open PRs.",
  "",
  "| Domain | Current files |",
  "|---|---|",
  ...domains.map((domain) => `| ${domain} | ${grouped.get(domain).map((file) => `\`${file}\``).join(", ")} |`),
  "",
  "New founder implementation files belong under `founder/`. Root `founder-*` files are compatibility re-exports and can be removed after open PRs have merged.",
  "",
].join("\n");

const rootFounderFiles = fs.readdirSync(sourceRoot).filter((name) => name.startsWith("founder-"));
const invalidRootFiles = rootFounderFiles.filter((name) => {
  const source = fs.readFileSync(path.join(sourceRoot, name), "utf8").trim();
  return !/^export \* from ["']\.\/founder\/founder-[^"']+["'];?(?:\s*export \{ default \} from ["']\.\/founder\/founder-[^"']+["'];?)?$/.test(source)
    && !/^export \{ default \} from ["']\.\/founder\/founder-[^"']+["'];?\s*export \* from ["']\.\/founder\/founder-[^"']+["'];?$/.test(source);
});
if (invalidRootFiles.length) throw new Error(`Founder implementations must live in src/founder/: ${invalidRootFiles.join(", ")}`);

if (process.argv.includes("--check")) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) throw new Error("docs/SOURCE-LAYOUT.md is stale; run node scripts/source-layout.mjs");
} else {
  fs.writeFileSync(outputPath, content);
}
