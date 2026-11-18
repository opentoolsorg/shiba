import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("sandbox client invokes actual workerd RPC methods after registering its name", async () => {
  const require = createRequire(await realpath(fileURLToPath(new URL("../node_modules/wrangler/package.json", import.meta.url))));
  const { build } = require("esbuild");
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/sandbox-rpc-worker.mjs", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*"],
  });
  const worker = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-06-01",
    durableObjects: { Sandbox: "RpcSandbox" },
    host: "127.0.0.1",
    port: 0,
    inspectorPort: 0,
    cf: false,
    telemetry: { enabled: false },
  }));
  try {
    const response = await worker.dispatchFetch("https://fixture/checkout");
    expect(await response.json()).toEqual({
      name: "sandbox-rpc-test",
      repo: "https://example.com/repo.git",
      options: { branch: "main" },
      calls: ["register", "checkout"],
    });
    expect(response.status).toBe(200);
    expect(await (await worker.dispatchFetch("https://fixture/empty")).json()).toEqual([]);
    for (const [route, message] of [["error", "checkout refused"], ["registration-error", "registration refused"]]) {
      const failure = await worker.dispatchFetch(`https://fixture/${route}`);
      expect(failure.status).toBe(500);
      expect(await failure.json()).toEqual({ error: message });
    }
  } finally {
    await worker.dispose();
  }
}, 30_000);

test("sandbox starts a real local container with its execution epoch label", async (context) => {
  const configuredHost = process.env.WRANGLER_DOCKER_HOST ?? process.env.DOCKER_HOST;
  const dockerArgs = configuredHost ? ["--host", configuredHost] : [];
  const docker = (args: string[], timeout: number) =>
    execFileSync("docker", [...dockerArgs, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout }).toString().trim();
  let socketPath: string;
  try {
    docker(["info", "--format", "{{.ServerVersion}}"], 5_000);
    socketPath = configuredHost ?? docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 5_000);
  } catch {
    return context.skip("Local Docker daemon is unavailable");
  }
  const image = "nginx:alpine@sha256:fed7e14be83cbd2661a75cdc5b872d936cf155d46c327084d30b8df19ae88d72";
  const containerEgressInterceptorImage = "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";
  for (const ref of [image, containerEgressInterceptorImage]) {
    try {
      docker(["image", "inspect", ref], 5_000);
    } catch {
      docker(["pull", ref], 60_000);
    }
  }
  const require = createRequire(await realpath(fileURLToPath(new URL("../node_modules/wrangler/package.json", import.meta.url))));
  const { build } = require("esbuild");
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/sandbox-container-worker.mjs", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
  });
  const worker = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-23",
    compatibilityFlags: ["nodejs_compat", "legacy_module_registry"],
    durableObjects: {
      Sandbox: {
        className: "Sandbox",
        useSQLite: true,
        container: { images: [{ name: "sandbox", image }] },
      },
    },
    containerEngine: { localDocker: { socketPath, containerEgressInterceptorImage } },
    host: "127.0.0.1",
    port: 0,
    inspectorPort: 0,
    cf: false,
    telemetry: { enabled: false },
  }));
  try {
    const response = await worker.dispatchFetch("https://fixture/");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toEqual({
      stdout: "sandbox started",
      exitCode: 0,
      epoch: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
  } finally {
    await worker.dispose();
  }
}, 150_000);
