import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { listMissingSetupSecrets } from "../src/setup-missing-secrets.js";

describe("setup status missing secrets", () => {
  it("lists secret names only, never values", () => {
    const env = {
      AI_GATEWAY_TOKEN: "super-secret",
      SHIBA_CODEX_SUBSCRIPTION: "0",
    } as unknown as Env;
    const rows = listMissingSetupSecrets(env);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("super-secret");
    expect(rows.every((row) => typeof row.secretName === "string" && row.secretName.length > 0)).toBe(true);
  });
});