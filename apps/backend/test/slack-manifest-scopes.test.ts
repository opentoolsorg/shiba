import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLACK_BOT_SCOPES } from "@shiba/shared";

const manifest = readFileSync(new URL("../../../slack-app-manifest.yaml", import.meta.url), "utf8");
const scopesBlock = manifest.slice(manifest.indexOf("  scopes:"), manifest.indexOf("settings:"));
const manifestScopes = scopesBlock.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "))
  .map((line) => line.slice(2).trim());

describe("shipped Slack app manifest", () => {
  it("grants the file scope the documented install needs to attach results", () => {
    expect(manifestScopes).toContain("chat:write");
    expect(manifestScopes).toContain("files:write");
    expect(SLACK_BOT_SCOPES).toContain("files:write");
  });
});
