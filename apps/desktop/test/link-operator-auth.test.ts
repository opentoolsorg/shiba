import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { linkOperatorAuth } = createRequire(import.meta.url)(
  "../../../scripts/link-operator-auth.mjs",
) as {
  linkOperatorAuth: (homeDir: string, userHome: string | undefined) => Promise<string[]>;
};

describe("linkOperatorAuth", () => {
  it("links .claude and .codex and leaves an envelope-written directory alone", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "shiba-user-"));
    const runHome = mkdtempSync(join(tmpdir(), "shiba-run-"));
    mkdirSync(join(userHome, ".claude"));
    mkdirSync(join(userHome, ".codex"));
    writeFileSync(join(userHome, ".codex", "auth.json"), "{}\n");
    mkdirSync(join(runHome, ".claude"));
    writeFileSync(join(runHome, ".claude", "owned"), "envelope\n");

    const linked = await linkOperatorAuth(runHome, userHome);
    expect(linked).toEqual([".codex"]);
    expect(readlinkSync(join(runHome, ".codex"))).toBe(join(userHome, ".codex"));
    expect(readFileSync(join(runHome, ".claude", "owned"), "utf8")).toBe("envelope\n");
  });

  it("does not link when the run home is the operator home", async () => {
    const home = mkdtempSync(join(tmpdir(), "shiba-same-"));
    expect(await linkOperatorAuth(home, home)).toEqual([]);
  });
});
