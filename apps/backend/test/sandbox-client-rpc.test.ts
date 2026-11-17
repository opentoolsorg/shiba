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
