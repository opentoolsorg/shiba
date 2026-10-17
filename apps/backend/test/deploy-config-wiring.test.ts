import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const WRANGLER = read("../wrangler.jsonc");
const ALCHEMY = read("../../../alchemy.run.ts");
const SCHEMA = read("../../../.env.schema");

function block(source: string, start: string): string {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf("])", from));
}

describe("deploy config wiring", () => {
  // P7 #3: unprovisioned DASHBOARD_APPROVERS = no surface can approve shared runs.
  it("provisions DASHBOARD_APPROVERS like SLACK_APPROVERS", () => {
    expect(block(ALCHEMY, "...secrets([")).toContain('"DASHBOARD_APPROVERS"');
    expect(SCHEMA).toMatch(/^DASHBOARD_APPROVERS=$/m);
    expect(WRANGLER).toContain("DASHBOARD_APPROVERS");
  });

  // P7 #6: without keep_vars every wrangler deploy deletes dashboard-set vars.
  it("keeps dashboard-set vars across wrangler deploys", () => {
    expect(WRANGLER).toMatch(/^\s*"keep_vars": true,$/m);
  });

  // P7 #6: flags missing from wrangler vars are wiped on every wrangler deploy.
  it.each([
    "SHIBA_CODEX_SUBSCRIPTION",
    "SHIBA_CURSOR_SUBSCRIPTION",
    "SHIBA_DEVIN_SUBSCRIPTION",
    "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
  ])("registers %s dark in wrangler vars, alchemy env and configVars", (flag) => {
    expect(WRANGLER).toContain(`"${flag}": "0"`);
    expect(ALCHEMY).toContain(`${flag}: "0"`);
    expect(block(ALCHEMY, "...configVars([")).toContain(`"${flag}"`);
  });
});
