import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const exec = promisify(execFile);

it.runIf(process.platform === "linux")("checks actual offline workerd restart, SQLite acknowledgment and TCP WebSocket replay", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const result = await exec(process.execPath, ["--test", "--test-reporter=tap", "apps/backend/test/acceptance/worker-journal-recovery.test.mjs"], {
    cwd: root, timeout: 175_000, maxBuffer: 200_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  expect(result.stdout, result.stderr).toContain("# pass 2");
  expect(result.stdout).toContain('"retentionGapExplicit":true');
}, 185_000);
