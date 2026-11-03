import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JournalPage } from "@shiba/sandbox";
import { EXECUTION_JOURNAL_SOURCE } from "../src/sandbox/execution-journal.js";

const exec = promisify(execFile);
const ROOT_LITERAL = 'const ROOT = "/var/lib/shiba-executions";';
const fixtures: Fixture[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitSyncFor = (condition: string) => `
  for (let attempts = 0; !(${condition}); attempts++) {
    if (attempts >= 400) throw new Error("Supervisor fixture barrier timed out.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
`;
const exists = (file: string) => fs.access(file).then(() => true, () => false);

interface Fixture {
  root: string;
  jobId: string;
  source: string;
  processes: ChildProcess[];
  start(script: string, deadline?: number, executionEnv?: Record<string, string>): ChildProcess;
  read(after?: number): Promise<JournalPage>;
  cancel(): Promise<unknown>;
}

async function fixture(instrument?: (source: string, root: string) => string): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-journal-supervisor-"));
  expect(EXECUTION_JOURNAL_SOURCE).toContain(ROOT_LITERAL);
  const localSource = EXECUTION_JOURNAL_SOURCE.replace(ROOT_LITERAL, `const ROOT = ${JSON.stringify(root)};`);
  const source = instrument ? instrument(localSource, root) : localSource;
  const jobId = createHash("sha256").update(root).digest("hex");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(root, "home"), SHIBA_IMAGE_FIXTURE: "image-default" };
  let expectedDeadline: number | undefined;
  const run = (operation: string, extra: string[] = []) => exec(process.execPath, ["-e", source, "--", operation, jobId, ...extra], {
    env, timeout: 3_000, maxBuffer: 600_000,
  });
  const item: Fixture = {
    root, jobId, source, processes: [],
    start(script, deadline = Date.now() + 4_000, executionEnv = {}) {
      expectedDeadline ??= deadline;
      const command = `${quote(process.execPath)} -e ${quote(script)}`;
      const child = spawn(process.execPath, ["-e", source, "--", "start", jobId], {
        env, detached: true, stdio: ["pipe", "ignore", "ignore"],
      });
      item.processes.push(child);
      if (!child.stdin) throw new Error("Supervisor fixture requires a stdin pipe.");
      child.stdin.end(JSON.stringify({ command, cwd: root, env: executionEnv, deadline, digest: "a".repeat(64) }));
      return child;
    },
    async read(after = 0) {
      try { return JSON.parse((await run("read", [String(after), "a".repeat(64), String(expectedDeadline)])).stdout) as JournalPage; }
      catch (error) {
        const output = (error as { stdout?: unknown }).stdout;
        if (typeof output !== "string" || !output) throw error;
        return JSON.parse(output) as JournalPage;
      }
    },
    async cancel() { return JSON.parse((await run("cancel")).stdout) as unknown; },
  };
  fixtures.push(item);
  return item;
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await delay(25);
  }
  throw new Error(`Fixture did not settle: ${JSON.stringify(last)}`);
}

async function drain(item: Fixture, after = 0): Promise<{ page: JournalPage; frames: JournalPage["frames"] }> {
  const frames: JournalPage["frames"] = [];
  let cursor = after;
  const page = await eventually(async () => {
    const next = await item.read(cursor);
    for (const frame of next.frames) {
      expect(frame.sequence).toBe(cursor + 1);
      expect(Buffer.from(frame.dataBase64, "base64").byteLength).toBeLessThanOrEqual(4_096);
      cursor = frame.sequence;
      frames.push(frame);
    }
    expect(next.frames.length).toBeLessThanOrEqual(64);
    expect(next.cursor).toBe(cursor);
    return next;
  }, (next) => next.done);
  return { page, frames };
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.cancel().catch(() => undefined);
    await drain(item).catch(() => undefined);
    for (const child of item.processes) {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The fixture already exited. */ }
      }
    }
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (await fs.readlink(`/proc/${entry}/cwd`) === item.root) process.kill(Number(entry), "SIGKILL");
      } catch { /* A local fixture can exit during cleanup. */ }
    }
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

describe("execution journal local supervisor", () => {
  it("keeps published startup metadata immutable while a reader holds its inode", async () => {
    const item = await fixture((source, root) => {
      const published = JSON.stringify(path.join(root, "metadata-published"));
      const reading = JSON.stringify(path.join(root, "metadata-reading"));
      const started = JSON.stringify(path.join(root, "startup-finished"));
      return source
        .replace('  fs.renameSync(temp, dir + "/" + file);', `
          fs.renameSync(temp, dir + "/" + file);
          if (action === "start" && file === "meta.json" && !fs.existsSync(${published})) {
            fs.writeFileSync(${published}, "ready");
            ${waitSyncFor(`fs.existsSync(${reading})`)}
          }
        `)
        .replace('    const named = fs.lstatSync(path, { bigint: true });', `
          if (action === "read" && path.endsWith("/meta.json")) {
            fs.writeFileSync(${reading}, "ready");
            ${waitSyncFor(`fs.existsSync(${started})`)}
          }
          const named = fs.lstatSync(path, { bigint: true });
        `)
        .replace('  const append = (stream, chunk) => {', `
          fs.writeFileSync(${started}, "ready");
          const append = (stream, chunk) => {
        `);
    });
    const finish = path.join(item.root, "allow-exit");
    const marker = path.join(item.root, "launches");
    item.start(`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'launch\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.stdout.write('complete')}},10)`);
    await eventually(() => exists(path.join(item.root, "metadata-published")), Boolean);
    expect(await item.read()).toMatchObject({ state: "running", done: false });
    await fs.writeFile(finish, "exit");
    const result = await drain(item);
    expect(result.page).toMatchObject({ state: "exited", exitCode: 0 });
    expect(await fs.readFile(marker, "utf8")).toBe("launch\n");
  });

  it.each(["valid", "digest", "lastSequence"] as const)("rechecks a %s receipt when completion wins the liveness race", async (kind) => {
    const item = await fixture((source, root) => {
      const finish = JSON.stringify(path.join(root, "allow-exit"));
      const corrupt = kind === "valid" ? "" : `
        const completed = jsonFile(dir + "/receipt.json");
        completed.${kind} = ${kind === "digest" ? JSON.stringify("b".repeat(64)) : "completed.lastSequence + 1"};
        fs.writeFileSync(dir + "/receipt.json", JSON.stringify(completed));
      `;
      return source.replace('      if (!receipt && !alive(meta.supervisorPid, meta.supervisorStart))', `
        if (!receipt) {
          fs.writeFileSync(${finish}, "exit");
          ${waitSyncFor('fs.existsSync(dir + "/receipt.json")')}
          ${waitSyncFor('!alive(meta.supervisorPid, meta.supervisorStart)')}
          ${corrupt}
        }
        if (!receipt && !alive(meta.supervisorPid, meta.supervisorStart))
      `);
    });
    const ready = path.join(item.root, "cli-ready");
    const finish = path.join(item.root, "allow-exit");
    item.start(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.stdout.write('complete')}},10)`);
    await eventually(() => exists(ready), Boolean);
    const page = await item.read();
    if (kind === "valid") {
      expect(page).toMatchObject({ state: "exited", exitCode: 0, done: true });
      expect(Buffer.concat(page.frames.map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString("utf8")).toBe("complete");
    } else expect(page).toMatchObject({ state: "lost", done: true });
  });

  it("claims one launch when start callers race and a caller loses its response", async () => {
    const item = await fixture();
    const marker = path.join(item.root, "launches");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'launch\\n');setTimeout(()=>process.stdout.write('complete'),150)`;
    const deadline = Date.now() + 4_000;
    item.start(script, deadline);
    item.start(script, deadline);
    const result = await drain(item);
    expect(result.page.state).toBe("exited");
    expect(result.page.exitCode).toBe(0);
    expect(await fs.readFile(marker, "utf8")).toBe("launch\n");
    item.start(script, deadline);
    await delay(100);
    expect(await fs.readFile(marker, "utf8")).toBe("launch\n");
  });

  it("replays exact stdout and stderr bytes after the reader disconnects", async () => {
    const item = await fixture();
    item.start(`let n=0;const timer=setInterval(()=>{process.stdout.write(Buffer.from([0xe2,0x82,0xac,n]));process.stderr.write(Buffer.from([0xc3,0xa9,n]));if(++n===20)clearInterval(timer)},15)`);
    const initial = await eventually(() => item.read(), (page) => page.frames.length > 0);
    await delay(500);
    const replay = await drain(item, initial.cursor);
    const frames = [...initial.frames, ...replay.frames];
    for (const stream of ["stdout", "stderr"] as const) {
      const actual = Buffer.concat(frames.filter((frame) => frame.stream === stream).map((frame) => Buffer.from(frame.dataBase64, "base64")));
      const expected = Buffer.concat(Array.from({ length: 20 }, (_, n) => Buffer.from(stream === "stdout" ? [0xe2, 0x82, 0xac, n] : [0xc3, 0xa9, n])));
      expect(actual.equals(expected)).toBe(true);
    }
    expect(replay.page).toMatchObject({ state: "exited", exitCode: 0, done: true });
    expect(await item.read(replay.page.cursor)).toMatchObject({ cursor: replay.page.cursor, frames: [], done: true });
  });

  it("enforces the original deadline without a reader and terminates a TERM-ignoring child", async () => {
    const item = await fixture();
    item.start("process.on('SIGTERM',()=>{});setInterval(()=>{},100)", Date.now() + 500);
    await delay(1_000);
    const result = await drain(item);
    expect(result.page.state).toBe("timed_out");
    expect(result.page.exitCode).not.toBe(0);
  });

  it("fails explicitly at the source output cap while no reader is attached", async () => {
    const item = await fixture();
    item.start("const b=Buffer.alloc(65536,120);function emit(){while(process.stdout.write(b)){}process.stdout.once('drain',emit)}emit()", Date.now() + 4_000);
    await delay(350);
    const result = await drain(item);
    expect(result.page.state).toBe("limited");
    expect(result.page.exitCode).not.toBe(0);
    expect(result.frames.length).toBeLessThanOrEqual(4_096);
    expect(result.frames.reduce((total, frame) => total + Buffer.from(frame.dataBase64, "base64").byteLength, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("honors idempotent cancellation and drains the source before a terminal receipt", async () => {
    const item = await fixture();
    item.start("process.stdout.write('started');process.on('SIGTERM',()=>{});setInterval(()=>{},100)");
    await eventually(() => item.read(), (page) => page.frames.length > 0);
    expect(await item.cancel()).toMatchObject({ jobId: item.jobId, state: "cancelled" });
    expect(await item.cancel()).toMatchObject({ jobId: item.jobId, state: "cancelled" });
    const result = await drain(item);
    expect(result.page).toMatchObject({ state: "cancelled", done: true });
    expect(result.page.exitCode).not.toBe(0);
  });

  it("waits for inherited output pipes after the command leader exits", async () => {
    const item = await fixture();
    const nested = "setTimeout(()=>process.stdout.write('late-output'),250)";
    item.start(`require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(nested)}],{stdio:['ignore',1,2]}).unref();process.exit(0)`);
    const result = await drain(item);
    expect(result.page).toMatchObject({ state: "exited", exitCode: 0 });
    const output = Buffer.concat(result.frames.filter((frame) => frame.stream === "stdout").map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString("utf8");
    expect(output).toBe("late-output");
  });

  it("bounds pipe draining when an escaped descendant outlives the deadline", async () => {
    const item = await fixture();
    const marker = path.join(item.root, "escaped-pid");
    const nested = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.on('error',()=>process.exit(0));setInterval(()=>process.stdout.write('held'),25);setTimeout(()=>process.exit(0),3000)`;
    const startedAt = Date.now();
    item.start(`require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(nested)}],{detached:true,stdio:['ignore',1,2]}).unref();process.exit(0)`, Date.now() + 400);
    const result = await drain(item);
    expect(result.page).toMatchObject({ state: "timed_out", done: true });
    expect(result.page.exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    const pid = Number(await fs.readFile(marker, "utf8"));
    await eventually(async () => {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
      } catch { return true; }
    }, (gone) => gone);
  });

  it("never signals another process named in tampered child PID metadata", async () => {
    const item = await fixture();
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { detached: true, stdio: "ignore", env: {} });
    item.processes.push(victim);
    try {
      const victimPid = victim.pid;
      if (victimPid === undefined) throw new Error("Victim fixture did not receive a process identity.");
      item.start("process.stdout.write('started');setInterval(()=>{},100)");
      await eventually(() => item.read(), (page) => page.frames.length > 0);
      const metadata = path.join(item.root, item.jobId, "meta.json");
      const meta = JSON.parse(await fs.readFile(metadata, "utf8")) as Record<string, unknown>;
      const victimStat = await fs.readFile(`/proc/${victimPid}/stat`, "utf8");
      meta.childPid = victimPid;
      meta.childStart = victimStat.slice(victimStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      await fs.writeFile(metadata, JSON.stringify(meta));
      expect(await item.cancel()).toMatchObject({ state: "cancelled" });
      await drain(item);
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
      expect(() => process.kill(victimPid, 0)).not.toThrow();
    } finally {
      victim.kill("SIGKILL");
      await eventually(async () => victim.signalCode, (signal) => signal !== null);
    }
  });

  it("preserves image environment for the CLI while isolating NODE_OPTIONS from control processes", async () => {
    const item = await fixture();
    const preload = path.join(item.root, "approved-preload.cjs");
    const marker = path.join(item.root, "preloaded-pids");
    await fs.writeFile(preload, `require('node:fs').appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n')`);
    item.start("process.stdout.write(JSON.stringify({pid:process.pid,home:process.env.HOME,path:process.env.PATH,image:process.env.SHIBA_IMAGE_FIXTURE,approved:process.env.SHIBA_APPROVED_FIXTURE}))", Date.now() + 4_000, {
      NODE_OPTIONS: `--require=${preload}`, SHIBA_APPROVED_FIXTURE: "approved-value",
    });
    const result = await drain(item);
    expect(result.page).toMatchObject({ state: "exited", exitCode: 0 });
    const output = Buffer.concat(result.frames.filter((frame) => frame.stream === "stdout").map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString("utf8");
    const cli = JSON.parse(output) as { pid: number; home: string; path: string; image: string; approved: string };
    expect(cli).toMatchObject({ home: path.join(item.root, "home"), path: process.env.PATH ?? "/usr/bin:/bin", image: "image-default", approved: "approved-value" });
    expect(await fs.readFile(marker, "utf8")).toBe(`${cli.pid}\n`);
    const metadata = JSON.parse(await fs.readFile(path.join(item.root, item.jobId, "meta.json"), "utf8")) as { childPid: number; supervisorPid: number };
    expect(cli.pid).not.toBe(metadata.childPid);
    expect(cli.pid).not.toBe(metadata.supervisorPid);
  });

  it.each(["bootId", "supervisorStart"] as const)("reports lost when %s no longer identifies this execution", async (field) => {
    const item = await fixture();
    item.start("process.stdout.write('started');setInterval(()=>{},100)");
    await eventually(() => item.read(), (page) => page.frames.length > 0);
    const metadata = path.join(item.root, item.jobId, "meta.json");
    const meta = JSON.parse(await fs.readFile(metadata, "utf8")) as Record<string, unknown>;
    meta[field] = field === "bootId" ? "another-instance" : "0";
    await fs.writeFile(metadata, JSON.stringify(meta));
    expect(await item.read()).toMatchObject({ state: "lost", done: true });
    expect(await item.cancel()).toMatchObject({ state: "cancelled" });
    const supervisor = item.processes[0];
    if (!supervisor) throw new Error("Supervisor fixture process was not retained.");
    await eventually(async () => supervisor.exitCode, (code) => code !== null);
  });

  it.each(["digest", "deadline"] as const)("refuses metadata whose %s differs from the Worker claim", async (field) => {
    const item = await fixture();
    item.start("process.stdout.write('complete')");
    await drain(item);
    const metadata = path.join(item.root, item.jobId, "meta.json");
    const meta = JSON.parse(await fs.readFile(metadata, "utf8")) as Record<string, unknown>;
    meta[field] = field === "digest" ? "b".repeat(64) : Number(meta.deadline) + 1;
    await fs.writeFile(metadata, JSON.stringify(meta));
    expect(await item.read()).toMatchObject({ state: "lost", done: true });
  });

  it.each(["symlink", "fifo", "hardlink"] as const)("refuses a %s used as the source journal without blocking", async (kind) => {
    const item = await fixture();
    item.start("process.stdout.write('complete')");
    await drain(item);
    const journal = path.join(item.root, item.jobId, "journal.jsonl");
    const original = path.join(item.root, "original-journal");
    await fs.rename(journal, original);
    if (kind === "symlink") await fs.symlink(original, journal);
    else if (kind === "hardlink") await fs.link(original, journal);
    else execFileSync("mkfifo", [journal]);
    expect(await item.read()).toMatchObject({ state: "lost", done: true });
    expect(await fs.readFile(original, "utf8")).toContain("Y29tcGxldGU=");
  });

  it.each(["truncated", "sequence", "base64", "oversize"] as const)("rejects a %s completed journal", async (kind) => {
    const item = await fixture();
    item.start("process.stdout.write('complete')");
    await drain(item);
    const journal = path.join(item.root, item.jobId, "journal.jsonl");
    const contents = await fs.readFile(journal, "utf8");
    const row = JSON.parse(contents.trim()) as Record<string, unknown>;
    if (kind === "truncated") await fs.writeFile(journal, contents.trim());
    else if (kind === "oversize") await fs.truncate(journal, 6_500_001);
    else {
      row[kind === "sequence" ? "sequence" : "dataBase64"] = kind === "sequence" ? 2 : "%%%%";
      await fs.writeFile(journal, `${JSON.stringify(row)}\n`);
    }
    expect(await item.read()).toMatchObject({ state: "lost", done: true });
  });

  it.each([-1, 0.5, 4_097, 1])("refuses invalid or future source cursor %s", async (cursor) => {
    const item = await fixture();
    item.start("process.exit(0)");
    await drain(item);
    expect(await item.read(cursor)).toMatchObject({ state: "lost", done: true });
  });
});
