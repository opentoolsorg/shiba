import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the live observer opt-in, identity, revision and replay safety gates in aggregate CI", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["--test", "scripts/control-plane-live-acceptance.test.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {},
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 20_000);
