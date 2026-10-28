import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["drive", "assert-journey", "drive-agent-threads", "drive-agent-lifecycle"])("preserves evidence before cleanup after %s fails", (failure) => {
  const root = mkdtempSync(join(tmpdir(), "verify-ci-"));
  const scripts = join(root, ".cursor/skills/verify-shiba/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts/run-ci.sh"), join(scripts, "run-ci.sh"));
  for (const name of ["launch", "doctor"]) writeFileSync(join(scripts, `${name}.sh`), "exit 0\n");
  for (const name of ["drive", "assert-journey", "drive-agent-threads", "drive-agent-lifecycle"]) writeFileSync(join(scripts, `${name}.mjs`), `process.exit(${name === failure ? 7 : 0});\n`);
  writeFileSync(join(scripts, "evidence.sh"), `echo evidence >> '${root}/order'; echo '${root}/evidence'\n`);
  writeFileSync(join(scripts, "cleanup.sh"), `echo cleanup >> '${root}/order'\n`);
  try {
    const proc = spawnSync("bash", [join(scripts, "run-ci.sh")], { encoding: "utf8", env: { ...process.env, VERIFY_AGENT_THREADS: "1", VERIFY_AGENT_LIFECYCLE: "1", PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") } });
    expect(proc.status).toBe(7);
    expect(readFileSync(join(root, "order"), "utf8")).toBe("evidence\ncleanup\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("cleans only the chosen invocation and preserves an unrelated listener on its recorded port", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-cleanup-"));
  const scripts = join(root, ".cursor/skills/verify-shiba/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts/cleanup.sh"), join(scripts, "cleanup.sh"));
  const defaultDir = join(root, ".verify");
  const invocation = join(root, "isolated-invocation");
  mkdirSync(join(defaultDir, "state"), { recursive: true });
  mkdirSync(join(invocation, "state"), { recursive: true });
  writeFileSync(join(defaultDir, "state/keep"), "other invocation");
  writeFileSync(join(invocation, "state/remove"), "this invocation");
  const serverSource = 'const http = require("node:http"); const server = http.createServer((_, res) => res.end("alive")); server.listen(0, "127.0.0.1", () => console.log(server.address().port)); process.on("SIGTERM", () => server.close(() => process.exit(0)));';
  const owned = spawn(process.execPath, ["-e", serverSource], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const foreign = spawn(process.execPath, ["-e", serverSource], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const ownedExit = once(owned, "exit");
  const foreignExit = once(foreign, "exit");
  const ownedLines = createInterface({ input: owned.stdout! });
  const foreignLines = createInterface({ input: foreign.stdout! });
  try {
    const [[ownedPort], [foreignPort]] = await Promise.all([once(ownedLines, "line"), once(foreignLines, "line")]);
    writeFileSync(join(defaultDir, "port"), String(foreignPort));
    writeFileSync(join(invocation, "port"), String(foreignPort));
    writeFileSync(join(invocation, "wrangler.pid"), String(owned.pid));
    const cleanup = spawn("bash", [join(scripts, "cleanup.sh")], {
      env: { ...process.env, VERIFY_DIR: invocation }, stdio: "ignore",
    });
    const [status] = await once(cleanup, "exit");
    expect(status).toBe(0);
    const [ownedCode] = await ownedExit;
    expect(ownedCode).toBe(0);
    expect((await fetch(`http://127.0.0.1:${foreignPort}`)).status).toBe(200);
    expect(readFileSync(join(defaultDir, "state/keep"), "utf8")).toBe("other invocation");
    expect(() => readFileSync(join(invocation, "wrangler.pid"))).toThrow();
    expect(() => readFileSync(join(invocation, "state/remove"))).toThrow();
    await expect(fetch(`http://127.0.0.1:${ownedPort}`)).rejects.toThrow();
  } finally {
    ownedLines.close(); foreignLines.close();
    if (owned.exitCode === null) owned.kill("SIGKILL");
    if (foreign.exitCode === null) foreign.kill("SIGKILL");
    await Promise.all([ownedExit, foreignExit]);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
