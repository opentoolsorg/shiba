import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["drive", "assert-journey"])("preserves evidence before cleanup after %s fails", (failure) => {
  const root = mkdtempSync(join(tmpdir(), "verify-ci-"));
  const scripts = join(root, ".cursor/skills/verify-shiba/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts/run-ci.sh"), join(scripts, "run-ci.sh"));
  for (const name of ["launch", "doctor"]) writeFileSync(join(scripts, `${name}.sh`), "exit 0\n");
  for (const name of ["drive", "assert-journey"]) writeFileSync(join(scripts, `${name}.mjs`), `process.exit(${name === failure ? 7 : 0});\n`);
  writeFileSync(join(scripts, "evidence.sh"), `echo evidence >> '${root}/order'; echo '${root}/evidence'\n`);
  writeFileSync(join(scripts, "cleanup.sh"), `echo cleanup >> '${root}/order'\n`);
  try {
    const proc = spawnSync("bash", [join(scripts, "run-ci.sh")], { encoding: "utf8", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") } });
    expect(proc.status).toBe(7);
    expect(readFileSync(join(root, "order"), "utf8")).toBe("evidence\ncleanup\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
