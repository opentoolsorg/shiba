import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const daemon = path.resolve("../../scripts/shiba-local-daemon.mjs");

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function run(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return exec(process.execPath, [daemon, "--once", ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: os.tmpdir(), SHIBA_WORKER_URL: "", LOCAL_ADAPTER_TOKEN: "", SHIBA_LOCAL_RUN_ROOT: root, ...env },
    timeout: 15_000,
  });
}

it.each([302, 307, 308])("diagnoses Access without forwarding a pairing token through a %s redirect", async (status) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-transport-"));
  let forwarded = 0;
  const destination = createServer((_request, response) => { forwarded++; response.end("{}"); });
  const target = await listen(destination);
  const source = createServer((_request, response) => {
    response.writeHead(status, { location: `${target}/pair` });
    response.end();
  });
  try {
    const origin = await listen(source);
    await expect(run(root, ["--connect", origin, "--pair", "one-time.secret"])).rejects.toMatchObject({
      code: 76,
      stderr: expect.stringContaining("Cloudflare Access bypass"),
    });
    expect(forwarded).toBe(0);
  } finally {
    await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("refuses to send a saved machine credential to an overridden deployment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-transport-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("{}"); });
  try {
    const origin = await listen(server);
    await writeFile(path.join(root, "config.json"), JSON.stringify({ workerUrl: "https://original.example", adapterToken: "saved-secret", machineId: "saved-machine" }));
    await expect(run(root, [], { SHIBA_WORKER_URL: origin })).rejects.toMatchObject({
      stderr: expect.stringContaining("Saved pairing belongs to another Worker URL"),
    });
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it.each(["http://remote.example", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret", "ftp://example.com"])(
  "rejects an unsafe Worker URL %s before pairing", async (url) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shiba-transport-"));
    try {
      await expect(run(root, ["--connect", url, "--pair", "one-time.secret"])).rejects.toMatchObject({
        stderr: expect.stringContaining("Worker URL must be an HTTPS origin"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000,
);

it("accepts an explicit deployment token and refuses authenticated control redirects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-transport-"));
  let forwarded = 0;
  const destination = createServer((_request, response) => { forwarded++; response.end("{}"); });
  const target = await listen(destination);
  const requests: string[] = [];
  const source = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer explicit-token");
    requests.push(request.url ?? "");
    response.writeHead(307, { location: `${target}/control` });
    response.end();
  });
  try {
    const origin = await listen(source);
    await writeFile(path.join(root, "config.json"), JSON.stringify({ workerUrl: "https://original.example", adapterToken: "saved-secret" }));
    await expect(run(root, [], { SHIBA_WORKER_URL: origin, LOCAL_ADAPTER_TOKEN: "explicit-token" })).rejects.toMatchObject({ code: 76 });
    expect(requests).toEqual(["/api/local/heartbeat"]);
    expect(forwarded).toBe(0);
  } finally {
    await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it.each([
  ['{"note":"Cloudflare Access is optional"}', 0, "no pending runs"],
  ["<!doctype html><title>Cloudflare Access</title>", 76, "HTML login page"],
  ['{"note":"Cloudflare Access",', 1, "response was not JSON"],
])("classifies a successful response by parsing JSON before HTML heuristics: %s", async (body, exit, diagnosis) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-transport-"));
  const server = createServer((request, response) => {
    response.end(request.url === "/api/local/heartbeat" ? "{}" : body);
  });
  try {
    const origin = await listen(server);
    if (exit === 0) expect((await run(root, [], { SHIBA_WORKER_URL: origin, LOCAL_ADAPTER_TOKEN: "fixture-token" })).stdout).toContain(diagnosis);
    else await expect(run(root, [], { SHIBA_WORKER_URL: origin, LOCAL_ADAPTER_TOKEN: "fixture-token" })).rejects.toMatchObject({ code: exit, stderr: expect.stringContaining(diagnosis) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("keeps actual network failures retryable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-transport-"));
  let claims = 0;
  let retried!: () => void;
  const retryObserved = new Promise<void>((resolve) => { retried = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/api/local/claim" && ++claims === 1) request.socket.destroy();
    else if (request.url === "/api/local/claim") { response.end('{"envelope":null}'); retried(); }
    else response.end("{}");
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const origin = await listen(server);
    child = spawn(process.execPath, [daemon, "--poll", "500"], {
      env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: os.tmpdir(), SHIBA_WORKER_URL: origin, LOCAL_ADAPTER_TOKEN: "fixture-token", SHIBA_LOCAL_RUN_ROOT: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([retryObserved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("network failure was not retried")), 10_000); })]); }
    finally { clearTimeout(timer); }
    const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
    child.kill("SIGTERM");
    await closed;
    expect(stderr).toContain("claim failed: fetch failed");
    expect(stderr).not.toContain("Access bypass");
    expect(claims).toBeGreaterThanOrEqual(2);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
