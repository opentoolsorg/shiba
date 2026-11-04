import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSlackCanvasUrl, parseSlackCanvasOwners } from "../src/slack-canvas.js";

const schema = fileURLToPath(new URL("../../../.env.schema", import.meta.url));
const example = fileURLToPath(new URL("../../../.env.example", import.meta.url));
const cli = fileURLToPath(new URL("../../../node_modules/varlock/bin/cli.js", import.meta.url));
const fixtureAccount = "0".repeat(32);
const policy = [{ teamId: "T1", channelId: "C1", ownerId: "owner@example.test" }];

function load(overrides: Record<string, string> = {}, copyExample = false) {
  const root = mkdtempSync(join(tmpdir(), "shiba-env-schema-"));
  try {
    copyFileSync(schema, join(root, ".env.schema"));
    if (copyExample) copyFileSync(example, join(root, ".env"));
    const result = spawnSync(process.execPath, [cli, "load", "--path", root, "--format", "json", "--agent", "--skip-cache"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, NO_COLOR: "1", CLOUDFLARE_ACCOUNT_ID: fixtureAccount, ...overrides },
      encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      values: result.status === 0 ? JSON.parse(result.stdout) as Record<string, unknown> : undefined,
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("actual Varlock deployment schema", () => {
  it.each([false, true])("accepts the disabled policy as a JSON string with copied example=%s", (copyExample) => {
    const result = load({}, copyExample);
    expect(result.status, result.stderr).toBe(0);
    expect(result.values?.SLACK_CANVAS_OWNERS).toBe("[]");
    expect(parseSlackCanvasOwners(result.values?.SLACK_CANVAS_OWNERS as string)).toEqual([]);
  }, 20_000);

  it("retains a configured policy string and its explicitly configured identities", () => {
    const raw = JSON.stringify(policy, null, 2);
    const result = load({ SLACK_CANVAS_OWNERS: raw }, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.values?.SLACK_CANVAS_OWNERS).toBe(raw);
    expect(parseSlackCanvasOwners(result.values?.SLACK_CANVAS_OWNERS as string)).toEqual(policy);
  }, 20_000);

  it.each([
    ["malformed JSON", '[{"teamId":'],
    ["a non-array policy", JSON.stringify(policy[0])],
    ["a JSON-string entry", JSON.stringify([JSON.stringify(policy[0])])],
  ])("does not coerce %s into a policy the runtime would accept", (_label, raw) => {
    const result = load({ SLACK_CANVAS_OWNERS: raw }, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.values?.SLACK_CANVAS_OWNERS).toBe(raw);
    const value = result.values?.SLACK_CANVAS_OWNERS as string;
    expect(parseSlackCanvasOwners(value)).toEqual([]);
    expect(buildSlackCanvasUrl({ SLACK_CANVAS_OWNERS: value, WORKER_HOSTNAME: "shiba.example.test", INTERNAL_SIGNING_KEY: "synthetic-fixture-signing-key-32-chars" },
      { threadKey: "slack:T1:C1:123.456", approvalId: "fixture-approval" })).toBeUndefined();
  }, 20_000);

  it.each(["", "invalid-account"])("preserves the required deployment account validation for %j", (account) => {
    const result = load({ CLOUDFLARE_ACCOUNT_ID: account }, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLOUDFLARE_ACCOUNT_ID");
  }, 20_000);
});
