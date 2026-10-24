import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it.each([false, true])("executes a local run (session=%s) without exposing daemon or unrelated shell secrets to repository children", async (session) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-daemon-env-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await exec("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "test\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  const forbidden = ["LOCAL_ADAPTER_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "UNRELATED_SECRET"];
  // The same repo-controlled executable runs during discovery and execution.
  await writeFile(path.join(bin, "codex"), [
    "#!/bin/sh",
    ...forbidden.map((key) => `[ -z "$${key}" ] || exit 42`),
    '[ "$1" = "--version" ] && exit 0',
    '[ "$OPENAI_API_KEY" = "local-provider-key" ] || exit 43',
    '[ "$RUN_SETTING" = "approved-setting" ] || exit 44',
    'echo "secret isolation passed"',
  ].join("\n"), { mode: 0o755 });

  const sessionScript = path.join(bin, "fake-claude.mjs");
  await writeFile(sessionScript, `
    import { createInterface } from "node:readline";
    if (${JSON.stringify(forbidden)}.some((key) => process.env[key])) process.exit(42);
    const effort = process.argv.indexOf("--effort");
    if (effort < 0 || process.argv[effort + 1] !== "high") process.exit(45);
    createInterface({ input: process.stdin }).on("line", () => {
      process.stdout.write(JSON.stringify({ type: "result", result: "secret isolation passed" }) + "\\n");
    });
  `);

  let result: { status: string; summary: string } | undefined;
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe("Bearer daemon-control-secret");
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { result?: typeof result };
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/local/claim") {
      response.end(JSON.stringify({ claimToken: "claim", envelope: {
        sandboxId: "env-test", harness: "codex", repoUrl: repo, baseBranch: "main",
        cloneDir: "${SHIBA_LOCAL_RUN_ROOT}/work", homeDir: "${SHIBA_LOCAL_RUN_ROOT}/home",
        env: { RUN_SETTING: "approved-setting", LOCAL_ADAPTER_TOKEN: "envelope-forgery", GITHUB_TOKEN: "envelope-github" },
        configFiles: [], setupCommands: [], setupAllowlist: [], execAllowlist: [],
        argv: ["codex"], deadlineAt: Date.now() + 30_000,
        task: "Check effort",
        ...(session ? { session: { provider: "claude", model: "claude-test", permissionMode: "approval-required", reasoningEffort: "high", bin: process.execPath, binArgs: [sessionScript] } } : {}),
      } }));
    } else {
      if (request.url === "/api/local/result") result = body.result;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const daemon = spawn(process.execPath, [path.resolve("../../scripts/shiba-local-daemon.mjs"), "--once"], {
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      SHIBA_LOCAL_RUN_ROOT: path.join(root, "run"),
      SHIBA_WORKER_URL: `http://127.0.0.1:${address.port}`,
      LOCAL_ADAPTER_TOKEN: "daemon-control-secret", GITHUB_TOKEN: "github-secret", GH_TOKEN: "gh-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret", UNRELATED_SECRET: "unrelated-secret",
      OPENAI_API_KEY: "local-provider-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  daemon.stdout.on("data", (chunk) => { output += String(chunk); });
  daemon.stderr.on("data", (chunk) => { output += String(chunk); });
  const timer = setTimeout(() => daemon.kill("SIGKILL"), 30_000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      daemon.on("error", reject);
      daemon.on("close", resolve);
    });
    expect(output).not.toContain("daemon-control-secret");
    expect(exitCode, output).toBe(0);
    expect(result).toMatchObject({ status: "completed", summary: session ? expect.stringContaining("secret isolation passed") : "secret isolation passed" });
  } finally {
    clearTimeout(timer);
    daemon.kill();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
