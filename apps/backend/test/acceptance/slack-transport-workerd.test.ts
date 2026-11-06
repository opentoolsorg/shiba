import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps fixed Slack transport compatibility and redirect rejection under actual local workerd", async () => {
  const result = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", "apps/backend/test/acceptance/slack-transport-workerd.test.mjs"], {
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)), timeout: 30_000, maxBuffer: 1_048_576,
  });
  expect(result.stderr).not.toMatch(/not ok|Invalid redirect/);
  expect(result.stdout).toContain("# pass 1");
}, 35_000);
