import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type TestContext } from "vitest";

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

async function checkContainerProbe(context: TestContext, image: string, path: string, check: (body: string) => void) {
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
    const response = await worker.dispatchFetch(`https://fixture${path}`);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    check(body);
  } finally {
    await worker.dispose();
  }
}

test("sandbox starts a real local container with its execution epoch label", async (context) => {
  const image = "nginx:alpine@sha256:fed7e14be83cbd2661a75cdc5b872d936cf155d46c327084d30b8df19ae88d72";
  await checkContainerProbe(context, image, "/", (body) => {
    expect(JSON.parse(body)).toEqual({
      stdout: "sandbox started",
      exitCode: 0,
      epoch: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
  });
}, 150_000);

// The live clone needs GitHub access even when the container images are cached.
test.skipIf(process.env.SHIBA_TEST_LIVE_GIT_CHECKOUT !== "1")("sandbox clones an approved repository with verified TLS", async (context) => {
  const image = "cloudflare/sandbox:0.12.9-opencode@sha256:7b84b0163bd93f090504daf2f8e33d74a219a90774802f028adbb5b9de8107b5";
  await checkContainerProbe(context, image, "/clone", (body) => {
    const result = JSON.parse(body);
    expect(result.error).toBeUndefined();
    expect(result.tls.exitCode).toBe(0);
    expect(result.tls.stdout).toContain("CA=present");
    expect(result.tls.stdout).toContain("GIT_SSL_CAINFO=/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(result.tls.stdout).toMatch(/^GIT_SSL_NO_VERIFY=$/m);
    expect(result.tls.stdout).toMatch(/^http\.sslVerify=true$/m);
    expect(result.repo.exitCode).toBe(0);
    expect(result.repo.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  });
}, 150_000);
