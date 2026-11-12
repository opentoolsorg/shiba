import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CURATED_MCP_VENDORS } from "@shiba/shared";
import { deploymentOAuthClientEnvKey } from "../src/external-mcp-oauth.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const WRANGLER = read("../wrangler.jsonc");
const ALCHEMY = read("../../../alchemy.run.ts");
const SCHEMA = read("../../../.env.schema");
const ENV_EXAMPLE = read("../../../.env.example");
const ENV_TYPES = read("../src/env.ts");
const WORKER_SECRETS = JSON.parse(read("../worker-secrets.json")) as { secrets: string[] };

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

  it("declares LOADER in wrangler and alchemy (Code Mode)", () => {
    expect(WRANGLER).toContain('"binding": "LOADER"');
    expect(ALCHEMY).toContain('Cloudflare.WorkerLoader("LOADER")');
  });

  it("worker-secrets.json matches alchemy secrets([...])", () => {
    const m = ALCHEMY.match(/\.\.\.secrets\s*\(\s*\[([\s\S]*?)\]\s*\)/);
    const inner = m?.[1];
    if (!inner) throw new Error("secrets([...]) block not found in alchemy.run.ts");
    const fromAlchemy = [...inner.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
    expect([...WORKER_SECRETS.secrets].sort()).toEqual([...new Set(fromAlchemy)].sort());
  });

  it("wires an optional operator OAuth client ID for every OAuth-capable curated MCP preset", () => {
    const configured = new Set(WORKER_SECRETS.secrets);
    const secretBlock = block(ALCHEMY, "...secrets([");
    expect(WRANGLER).toContain("MCP_OAUTH_CLIENT_*");
    expect(CURATED_MCP_VENDORS.map((vendor) => vendor.catalogId).sort()).toEqual([
      "figma", "github-readonly", "jira-atlassian", "linear-readonly", "notion", "posthog", "sentry", "stripe",
    ]);
    for (const { catalogId } of CURATED_MCP_VENDORS.filter((vendor) => vendor.connectionMethods.includes("oauth"))) {
      const key = deploymentOAuthClientEnvKey(catalogId);
      expect(secretBlock, `${key} must be bound by Alchemy`).toContain(`"${key}"`);
      expect(configured, `${key} must be available to Wrangler operators`).toContain(key);
      expect(ENV_TYPES, `${key} must be typed on Worker Env`).toMatch(new RegExp(`\\b${key}\\?: string;`));
      expect(SCHEMA, `${key} must be declared in .env.schema`).toMatch(new RegExp(`^${key}=$`, "m"));
      expect(ENV_EXAMPLE, `${key} must be documented in .env.example`).toMatch(new RegExp(`^${key}=$`, "m"));
    }
  });

  // P7 #6: flags missing from wrangler vars are wiped on every wrangler deploy.
  it.each([
    "SHIBA_CODEX_SUBSCRIPTION",
    "SHIBA_CURSOR_SUBSCRIPTION",
    "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
  ])("registers %s dark in wrangler vars, alchemy env and configVars", (flag) => {
    expect(WRANGLER).toContain(`"${flag}": "0"`);
    expect(ALCHEMY).toContain(`${flag}: "0"`);
    expect(block(ALCHEMY, "...configVars([")).toContain(`"${flag}"`);
  });
});
