import { execFile, spawn } from "node:child_process";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_RUN_ROOT_TOKEN } from "@shiba/shared";

interface CapturedFile { path: string; content: string; encoding: "utf8" }
const helperUrl = new URL("../../../scripts/local-deliverables.mjs", import.meta.url);
const { captureExpectedDeliverables } = await import(helperUrl.href) as {
  captureExpectedDeliverables: (root: string, paths?: unknown) => Promise<CapturedFile[]>;
};
const exec = promisify(execFile);
let root: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "shiba-deliverables-"));
  repo = path.join(root, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "Original repository\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial repository"]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(relative: string, content: string | Uint8Array) {
  await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
  await writeFile(path.join(repo, relative), content);
}

describe("strict requested deliverable capture", () => {
  it("captures complete requested text including an unchanged tracked file without modifying Git state", async () => {
    await put("marketing/brief.md", "# Launch\nA complete brief.\n");
    const before = await exec("git", ["-C", repo, "status", "--porcelain"]);
    expect(await captureExpectedDeliverables(repo, ["marketing/brief.md", "README.md"])).toEqual([
      { path: "marketing/brief.md", content: "# Launch\nA complete brief.\n", encoding: "utf8" },
      { path: "README.md", content: "Original repository\n", encoding: "utf8" },
    ]);
    expect((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout).toBe(before.stdout);
  });

  it("uses UTF-8 byte limits and preserves a complete multibyte file at the 16 KiB boundary", async () => {
    const complete = "é".repeat(8192);
    await put("brief.txt", complete);
    expect((await captureExpectedDeliverables(repo, ["brief.txt"]))[0]?.content).toBe(complete);
    await put("brief.txt", `${complete}é`);
    await expect(captureExpectedDeliverables(repo, ["brief.txt"])).rejects.toThrow("16384");
  });

  it("preserves a UTF-8 BOM so returned content retains the file's exact bytes", async () => {
    const original = Buffer.from("\uFEFF# Complete file\n", "utf8");
    await put("brief.md", original);
    const [captured] = await captureExpectedDeliverables(repo, ["brief.md"]);
    expect(Buffer.from(captured?.content ?? "", "utf8")).toEqual(original);
  });

  it("rejects a native file truncated during capture rather than returning its readable prefix", async () => {
    const target = path.join(repo, "brief.md");
    await put("brief.md", "A complete deliverable that must not become a prefix.");
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalRead = handle.read.bind(handle);
      let truncated = false;
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await originalRead(...readArgs);
        if (!truncated && result.bytesRead > 0) {
          truncated = true;
          await fs.truncate(target, 2);
        }
        return result;
      }) as typeof handle.read;
      return handle;
    });
    try {
      await expect(captureExpectedDeliverables(repo, ["brief.md"])).rejects.toThrow("truncated");
    } finally { open.mockRestore(); }
  });

  it("accepts exactly 64 KiB total and rejects an additional byte without partial results", async () => {
    const names = ["one.txt", "two.txt", "three.txt", "four.txt"];
    for (const name of names) await put(name, "x".repeat(16384));
    expect(await captureExpectedDeliverables(repo, names)).toHaveLength(4);
    await put("fifth.txt", "x");
    await expect(captureExpectedDeliverables(repo, [...names, "fifth.txt"])).rejects.toThrow("65536");
  });

  it.each([
    { name: "missing", body: undefined },
    { name: "empty", body: Buffer.alloc(0) },
    { name: "blank", body: Buffer.from(" \n\t") },
    { name: "binary", body: Buffer.from([65, 0, 66]) },
    { name: "invalid UTF-8", body: Buffer.from([0xc3, 0x28]) },
    { name: "truncated UTF-8", body: Buffer.from([0x61, 0xe2, 0x82]) },
    { name: "large", body: Buffer.from("a".repeat(16385)) },
  ])("fails closed for $name output", async ({ body }) => {
    if (body !== undefined) await put("brief.md", body);
    await expect(captureExpectedDeliverables(repo, ["brief.md"])).rejects.toThrow("Expected deliverable brief.md");
  });

  it("rejects a deleted tracked deliverable instead of treating null content as success", async () => {
    await rm(path.join(repo, "README.md"));
    await expect(captureExpectedDeliverables(repo, ["README.md"])).rejects.toThrow("could not be captured");
  });

  it("rejects a directory in place of a regular file", async () => {
    await mkdir(path.join(repo, "brief.md"));
    await expect(captureExpectedDeliverables(repo, ["brief.md"])).rejects.toThrow("regular file");
  });

  it("rejects a native hard link to an outside file despite an inside-root realpath", async () => {
    const outside = path.join(root, "fictional-outside.txt");
    await writeFile(outside, "Fictional outside repository content, never approved for capture.\n");
    await link(outside, path.join(repo, "report.txt"));
    expect((await fs.lstat(path.join(repo, "report.txt"))).nlink).toBe(2);
    await expect(captureExpectedDeliverables(repo, ["report.txt"])).rejects.toThrow("hard-linked files are not allowed");
  });

  it("rejects a file hard-linked outside after capture starts", async () => {
    const target = path.join(repo, "report.txt");
    await put("report.txt", "Initially private workspace output.\n");
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalRead = handle.read.bind(handle);
      let linked = false;
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await originalRead(...readArgs);
        if (!linked && result.bytesRead > 0) {
          linked = true;
          await link(target, path.join(root, "created-during-capture.txt"));
        }
        return result;
      }) as typeof handle.read;
      return handle;
    });
    try {
      await expect(captureExpectedDeliverables(repo, ["report.txt"])).rejects.toThrow("hard-linked files are not allowed");
    } finally { open.mockRestore(); }
  });

  it.each([
    { parent: false, outside: false }, { parent: false, outside: true },
    { parent: true, outside: false }, { parent: true, outside: true },
  ])("rejects symlink parent=$parent outside=$outside", async ({ parent, outside }) => {
    const targetDir = outside ? path.join(root, "outside") : path.join(repo, "actual");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "brief.md"), "must not be captured through a link");
    if (parent) await symlink(targetDir, path.join(repo, "linked"), "dir");
    else await symlink(path.join(targetDir, "brief.md"), path.join(repo, "linked.md"), "file");
    await expect(captureExpectedDeliverables(repo, [parent ? "linked/brief.md" : "linked.md"])).rejects.toThrow("symlink");
  });

  it.each([
    "../outside.md", "/tmp/outside.md", ".git/config.md", "safe/../outside.md", "safe/.hidden/file.md",
    "safe\\outside.md", "brief.exe", "brief.md\n", "safe//brief.md", "C:/brief.md",
  ])("rejects an unsafe requested path before reading: %j", async (name) => {
    await expect(captureExpectedDeliverables(repo, [name])).rejects.toThrow("safe relative");
  });

  it("bounds and deduplicates requests including case-insensitive collisions", async () => {
    await expect(captureExpectedDeliverables(repo, Array.from({ length: 9 }, (_, index) => `${index}.md`))).rejects.toThrow("at most 8");
    await expect(captureExpectedDeliverables(repo, ["Brief.md", "brief.md"])).rejects.toThrow("unique");
    expect(await captureExpectedDeliverables(repo, undefined)).toEqual([]);
    expect(await captureExpectedDeliverables(repo, [])).toEqual([]);
  });
});

interface DaemonResult { status: string; exitCode: number; summary: string; changedFiles: string[]; diff: string; files: CapturedFile[] }
async function daemonRun(program: string, expectedDeliverables?: string[], expectedExit = 0): Promise<DaemonResult | undefined> {
  const bin = path.join(root, "bin");
  const operatorHome = path.join(root, "operator-home");
  await mkdir(bin);
  await mkdir(operatorHome);
  await writeFile(path.join(bin, "codex"), `#!${process.execPath}\nif (process.argv[2] === '--version') process.exit(0);\n${program}\n`, { mode: 0o755 });
  let result: DaemonResult | undefined;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { result?: DaemonResult };
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/local/claim") {
      response.end(JSON.stringify({ claimToken: "deliverable-claim", envelope: {
        sandboxId: "deliverable-run", harness: "codex", repoUrl: repo, baseBranch: "main",
        cloneDir: `${LOCAL_RUN_ROOT_TOKEN}/work`, homeDir: `${LOCAL_RUN_ROOT_TOKEN}/home`,
        configFiles: [], setupCommands: [], setupAllowlist: [], execAllowlist: [], env: {}, argv: ["codex"],
        deadlineAt: Date.now() + 30_000, ...(expectedDeliverables ? { expectedDeliverables } : {}),
      } }));
    } else {
      if (request.url === "/api/local/result") result = body.result;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const daemon = spawn(process.execPath, [fileURLToPath(new URL("../../../scripts/shiba-local-daemon.mjs", import.meta.url)), "--once"], {
    env: { ...process.env, HOME: operatorHome, PATH: `${bin}:${process.env.PATH}`, SHIBA_LOCAL_RUN_ROOT: path.join(root, "run"),
      SHIBA_WORKER_URL: `http://127.0.0.1:${address.port}`, LOCAL_ADAPTER_TOKEN: "test-deliverable-control" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  daemon.stdout.on("data", (chunk) => { output += String(chunk); });
  daemon.stderr.on("data", (chunk) => { output += String(chunk); });
  const timer = setTimeout(() => daemon.kill("SIGKILL"), 30_000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { daemon.on("error", reject); daemon.on("close", resolve); });
    expect(exit, output).toBe(expectedExit);
    return result;
  } finally {
    clearTimeout(timer);
    daemon.kill();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("daemon requested deliverable collection", () => {
  it("prioritizes requested outputs ahead of more than 50 changed files while retaining the Git diff", async () => {
    const result = await daemonRun(`const fs = require('node:fs');
for (let i=0;i<60;i++) fs.writeFileSync('a'+String(i).padStart(2,'0')+'.txt','other change\\n');
fs.writeFileSync('zz-brief.md','# Complete requested brief\\n');
console.log('agent claims success');`, ["zz-brief.md"]);
    expect(result?.status).toBe("completed");
    expect(result?.files[0]).toEqual({ path: "zz-brief.md", content: "# Complete requested brief\n", encoding: "utf8" });
    expect(result?.files).toHaveLength(50);
    expect(result?.changedFiles).toHaveLength(61);
    expect(result?.diff).toContain("diff --git a/zz-brief.md b/zz-brief.md");
  }, 40_000);

  it("returns an error rather than falling back to harness success when a requested file is absent", async () => {
    const result = await daemonRun("console.log('everything succeeded');", ["missing.md"], 1);
    expect(result?.status).toBe("error");
    expect(result?.exitCode).not.toBe(0);
    expect(result?.summary).toContain("Expected deliverable missing.md");
    expect(result?.files).toEqual([]);
  }, 40_000);

  it("keeps the legacy no-deliverable no-change success contract", async () => {
    const result = await daemonRun("console.log('legacy run completed');");
    expect(result).toMatchObject({ status: "completed", exitCode: 0, summary: "legacy run completed", changedFiles: [], diff: "", files: [] });
  }, 40_000);
});
