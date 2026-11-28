import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });

async function restricted(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

test("app source must import a workspace package by name, not by its source path", async () => {
  assert.ok((await restricted("apps/frontend/src/components/Example.tsx", 'import { x } from "../../../../packages/shared/src/swarm-desk.js";\n')).length > 0);
  assert.ok((await restricted("apps/backend/src/example.ts", 'import { x } from "../../../packages/shared/src/index.js";\n')).length > 0);
  assert.deepEqual(await restricted("apps/frontend/src/components/Example.tsx", 'import { x } from "@shiba/shared";\n'), []);
});

test("packages must not reach into apps or into another package's source", async () => {
  assert.equal((await restricted("packages/shared/src/example.ts", 'import type { Env } from "../../../apps/backend/src/env.js";\n')).length, 1);
  assert.equal((await restricted("packages/auth/src/example.ts", 'import { x } from "../../shared/src/index.js";\n')).length, 1);
  assert.deepEqual(await restricted("packages/auth/test/example.test.ts", 'import { x } from "../src/index.js";\n'), []);
});

test("lint:imports discovers workspace sources without shell glob expansion", () => {
  const script = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["lint:imports"];
  assert.match(script, /node scripts\/lint-imports\.mjs/);
  const runner = readFileSync(new URL("../scripts/lint-imports.mjs", import.meta.url), "utf8");
  assert.match(runner, /readdirSync\("apps"/);
  assert.match(runner, /readdirSync\("packages"/);
  assert.match(runner, /packages\/\$\{entry\.name\}\/test/);
});
