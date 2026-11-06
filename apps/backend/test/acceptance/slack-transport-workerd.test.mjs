import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("actual workerd executes fixed Slack transports and refuses every redirect", { timeout: 30_000 }, async () => {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const require = createRequire(await realpath(path.join(repo, "node_modules/wrangler/package.json")));
  const { build } = require("esbuild"), { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require("miniflare");
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-slack-transport-"));
  let worker;
  const calls = [];
  try {
    const bundle = path.join(root, "worker.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("./slack-transport-fixture-entry.ts", import.meta.url))], outfile: bundle,
      bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"], logLevel: "silent" });
    worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: await readFile(bundle,"utf8"), compatibilityDate: "2026-06-01", compatibilityFlags: ["nodejs_compat"],
      host: "127.0.0.1", port: 0, inspectorPort: 0, cf: false, telemetry: { enabled: false }, logRequests: false, log: new Log(LogLevel.ERROR),
      resourcePersistencePath: path.join(root, "state"), isolatedResourcePersistencePath: path.join(root, "isolated"), resourceTmpPath: path.join(root, "tmp"), unsafeDevRegistryPath: path.join(root, "dev-registry"),
      outboundService: async (request) => {
        const url = new URL(request.url); calls.push(url.origin + url.pathname);
        assert.equal(url.origin, "https://slack.com", "No external network or redirect destination is reachable");
        assert.equal(request.method, "POST");
        if (request.headers.get("authorization") === "Bearer fixture-redirect") return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/secret" } });
        if (url.pathname === "/api/auth.test") return Response.json({ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" });
        assert.equal(url.pathname, "/api/chat.postMessage");
        const body = await request.json(); assert.equal(body.text, "Fixture reviewed text"); assert.equal(body.mrkdwn, false); assert.equal(body.unfurl_links, false);
        return Response.json({ ok: true, channel: "C123", ts: "1.100000" });
      },
    }));
    for (const route of ["auth", "post"]) {
      const before = calls.length;
      assert.equal((await (await worker.dispatchFetch(`https://local.fixture/${route}`)).json()).ok, true, `${route} uses options accepted by actual workerd`);
      assert.equal(calls.length, before + 1);
      assert.equal((await (await worker.dispatchFetch(`https://local.fixture/${route}?redirect=1`)).json()).ok, false, `${route} rejects a redirected response`);
      assert.equal(calls.length, before + 2, `${route} never follows the redirected credential request`);
    }
    assert(calls.every((url) => url.startsWith("https://slack.com/api/")));
  } finally { if (worker) await worker.dispose(); await rm(root, { recursive: true, force: true }); }
});
