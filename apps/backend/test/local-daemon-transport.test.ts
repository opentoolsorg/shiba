import { execFile } from "node:child_process";
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
    env: { ...process.env, SHIBA_WORKER_URL: "", LOCAL_ADAPTER_TOKEN: "", SHIBA_LOCAL_RUN_ROOT: root, ...env },
    timeout: 15_000,
  });
}

it.each([307, 308])("does not forward a pairing token through a %s redirect", async (status) => {
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
      stderr: expect.stringContaining("pairing failed"),
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
    await expect(run(root, [], { SHIBA_WORKER_URL: origin, LOCAL_ADAPTER_TOKEN: "explicit-token" })).rejects.toMatchObject({ code: 1 });
    expect(requests).toEqual(["/api/local/heartbeat", "/api/local/claim"]);
    expect(forwarded).toBe(0);
  } finally {
    await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
