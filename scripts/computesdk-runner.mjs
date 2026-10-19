#!/usr/bin/env node
/**
 * Node/Bun sidecar: exposes ComputeSDK instances over HTTP for the Worker
 * (`SHIBA_COMPUTESDK_RUNNER_URL` + `SHIBA_COMPUTESDK_RUNNER_TOKEN`).
 *
 * Usage:
 *   SHIBA_COMPUTESDK_PROVIDER=e2b E2B_API_KEY=... SHIBA_COMPUTESDK_RUNNER_TOKEN=secret node scripts/computesdk-runner.mjs
 */
import { createServer } from "node:http";

const token = process.env.SHIBA_COMPUTESDK_RUNNER_TOKEN?.trim();
if (!token) {
  console.error("SHIBA_COMPUTESDK_RUNNER_TOKEN is required.");
  process.exit(1);
}

const port = Number.parseInt(process.env.SHIBA_COMPUTESDK_RUNNER_PORT ?? "8789", 10);
const instances = new Map();

async function loadClient() {
  const { loadComputesdkClient } = await import("@shiba/sandbox/adapters/computesdk-load");
  return loadComputesdkClient(process.env);
}

const clientPromise = loadClient();

function unauthorized(res) {
  res.writeHead(401);
  res.end("unauthorized");
}

const server = createServer(async (req, res) => {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${token}`) return unauthorized(res);
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const client = await clientPromise;

  if (url.pathname === "/v1/instances" && req.method === "POST") {
    const inst = await client.instances.create();
    instances.set(inst.instanceId, inst);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ instanceId: inst.instanceId, provider: inst.provider }));
    return;
  }

  const match = url.pathname.match(/^\/v1\/instances\/([^/]+)(\/.*)?$/);
  if (!match) {
    res.writeHead(404);
    res.end();
    return;
  }
  const instanceId = decodeURIComponent(match[1]);
  const rest = match[2] ?? "";
  let inst = instances.get(instanceId);
  if (!inst) {
    inst = await client.instances.getById(instanceId);
    if (inst) instances.set(instanceId, inst);
  }
  if (!inst) {
    res.writeHead(404);
    res.end();
    return;
  }

  const readBody = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };

  if (rest === "" && req.method === "DELETE") {
    await client.instances.destroy(instanceId);
    instances.delete(instanceId);
    res.writeHead(204);
    res.end();
    return;
  }

  if (rest === "/exec" && req.method === "POST") {
    const body = JSON.parse(await readBody());
    const result = await inst.runCommand(body.command, {
      cwd: body.cwd,
      env: body.env,
      timeout: body.timeout,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`computesdk runner listening on :${port}`);
});
