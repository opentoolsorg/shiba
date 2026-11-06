// SQLite/DO fixture with a fake Container transport. It proves the policy code, not deployed Cloudflare enforcement.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { matchPublicBrowserUrl, type PublicBrowserManifest } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { PublicBrowserApproval, PublicBrowserPolicy } from "../src/public-browser.js";
import { PublicBrowserSession } from "../src/public-browser-session.js";
import { publicBrowserOutbound, type PublicBrowserOutboundProps } from "../src/public-browser-outbound.js";

const IMAGE = `registry.cloudflare.com/test/public-browser@sha256:${"b".repeat(64)}`;
const OFFLINE_IMAGE = `registry.cloudflare.com/test/offline@sha256:${"a".repeat(64)}`;
const SESSION = `spb_${"c".repeat(32)}`;
const MANIFEST: PublicBrowserManifest = { policy: "shiba.public-browser.v1", catalogRevision: "fixture-1", startUrl: "https://docs.example.test/guide",
  targets: [
    { host: "docs.example.test", pathPrefixes: ["/guide", "/assets/"], queryKeys: ["page"], navigate: true, subresources: true },
    { host: "cdn.example.test", pathPrefixes: ["/"], queryKeys: [], navigate: false, subresources: true },
  ] };
const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const empty = () => new ReadableStream({ start(c) { c.close(); } });

function fixture(overrides: Partial<Env> = {}) {
  const upstream: Request[] = [];
  let respond: (request: Request) => Response = () => new Response("<p>ok</p>", { headers: { "content-type": "text/html", "set-cookie": "tracker=1" } });
  class FakeContainer {
    running = false; starts: Array<Record<string, unknown>> = []; intercepts: Array<[string, Fetcher]> = []; execs: Array<{ argv: string[]; intercepts: number }> = []; destroyed = 0; failIntercept = false;
    start(options: Record<string, unknown>) { this.starts.push(options); this.running = true; }
    async interceptAllOutboundHttp(binding: Fetcher) { if (this.failIntercept) throw new Error("interceptor unavailable"); this.intercepts.push(["http", binding]); }
    async interceptOutboundHttps(addr: string, binding: Fetcher) { this.intercepts.push([`https:${addr}`, binding]); }
    async setInactivityTimeout() {}
    async exec(argv: string[]) { this.execs.push({ argv, intercepts: this.intercepts.length }); return { stdout: empty(), stderr: empty(), exitCode: Promise.resolve(0), kill() {} }; }
    async destroy() { this.running = false; this.destroyed++; }
    /** The container's only network path: an installed interceptor. enableInternet=false means no route otherwise. */
    async request(url: string, init?: RequestInit) {
      const hit = this.intercepts.find(([kind]) => kind === (url.startsWith("https:") ? "https:*" : "http"));
      if (!hit) throw new Error("no route");
      return hit[1].fetch(new Request(url, init));
    }
  }
  const env = { SHIBA_PUBLIC_BROWSER: "1", SHIBA_PUBLIC_BROWSER_IMAGE: IMAGE, SHIBA_PUBLIC_BROWSER_CATALOG: JSON.stringify(MANIFEST), SHIBA_SHARED_COMPUTER_IMAGE: OFFLINE_IMAGE,
    INTERNAL_SIGNING_KEY: "fixture-only-internal-control-key-20261106", ...overrides } as Env;
  const instances = new Map<string, PublicBrowserSession>(), container = new FakeContainer();
  const id = (name: string) => ({ name, equals(other: { name: string }) { return other.name === name; } });
  env.PublicBrowserSession = { idFromName: id, get(value: { name: string }) {
    if (!instances.has(value.name)) {
      const sqlite = new DatabaseSync(":memory:");
      const ctx = { id: value, container,
        exports: { PublicBrowserOutbound: ({ props }: { props: PublicBrowserOutboundProps }) => ({ fetch: (request: Request) => publicBrowserOutbound(env, props, request, async (forwarded) => { upstream.push(forwarded); return respond(forwarded); }) }) },
        storage: { sql: { exec(sql: string, ...args: unknown[]) { const statement = sqlite.prepare(sql); if (/^SELECT/.test(sql)) { const rows = statement.all(...args as never[]); return { rowsWritten: 0, toArray: () => rows }; } const result = statement.run(...args as never[]); return { rowsWritten: Number(result.changes), toArray: () => [] }; } },
          setAlarm: async () => {}, deleteAlarm: async () => {} } };
      instances.set(value.name, new PublicBrowserSession(ctx as unknown as DurableObjectState, env));
    }
    return instances.get(value.name)!;
  } } as unknown as NonNullable<Env["PublicBrowserSession"]>;
  for (const key of ["AI", "Sandbox", "CodingOrchestrator", "LOCAL_ADAPTER_TOKEN", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "AI_GATEWAY_TOKEN", "ComputerSession"])
    Object.defineProperty(env, key, { get() { throw new Error(`Public browser must not access ${key}`); } });
  const runtime = () => env.PublicBrowserSession!.get(env.PublicBrowserSession!.idFromName(SESSION)) as unknown as PublicBrowserSession;
  const approve = async (overrides: Partial<{ sessionId: string; digest: string }> = {}) => {
    const policy = await PublicBrowserPolicy.read(env);
    return PublicBrowserApproval.sign(env, { sessionId: SESSION, digest: policy.digest!, approvedBy: "owner@example.test", sessionExpiresAt: Date.now() + 300_000, ...overrides });
  };
  const started = async () => { await runtime().startBrowser(await approve()); return container; };
  return { env, container, upstream, runtime, approve, started, respond: (fn: (request: Request) => Response) => { respond = fn; } };
}

describe("public browser mode is separate and default-off", () => {
  it("is unavailable unless every operator piece is present, and never reuses the offline image", async () => {
    expect((await PublicBrowserPolicy.read({} as Env)).reason).toBe("public_browser_disabled");
    expect((await PublicBrowserPolicy.read({ SHIBA_PUBLIC_BROWSER: "1" } as Env)).reason).toBe("public_browser_image_unavailable");
    expect((await PublicBrowserPolicy.read(fixture({ SHIBA_PUBLIC_BROWSER_IMAGE: OFFLINE_IMAGE }).env)).reason).toBe("public_browser_image_shared_with_offline");
    expect((await PublicBrowserPolicy.read(fixture({ SHIBA_PUBLIC_BROWSER_CATALOG: "" }).env)).reason).toBe("public_browser_catalog_unavailable");
    expect((await PublicBrowserPolicy.read(fixture().env)).available).toBe(true);
    for (const config of [file("../wrangler.jsonc"), file("../../../alchemy.run.ts")]) {
      expect(config).toMatch(/"?SHIBA_PUBLIC_BROWSER"?: "0"/);
      expect(config).not.toMatch(/PublicBrowserSession/);
    }
  });
  it("rejects manifests that widen network authority", async () => {
    const target = MANIFEST.targets[0]!;
    for (const targets of [[{ ...target, host: "*.example.test" }], [{ ...target, host: "10.0.0.1" }], [{ ...target, host: "localhost" }], [{ ...target, host: "docs.example.test." }],
      [{ ...target, host: "metadata.internal" }], [{ ...target, pathPrefixes: ["/../admin"] }], [{ ...target, extra: true }]]) {
      const env = fixture({ SHIBA_PUBLIC_BROWSER_CATALOG: JSON.stringify({ ...MANIFEST, startUrl: "https://docs.example.test/guide", targets }) }).env;
      expect((await PublicBrowserPolicy.read(env)).reason).toBe("public_browser_catalog_unavailable");
    }
    for (const startUrl of ["http://docs.example.test/guide", "https://docs.example.test:8443/guide", "https://user@docs.example.test/guide", "https://cdn.example.test/x"])
      expect((await PublicBrowserPolicy.read(fixture({ SHIBA_PUBLIC_BROWSER_CATALOG: JSON.stringify({ ...MANIFEST, startUrl }) }).env)).reason).toBe("public_browser_catalog_unavailable");
  });
  it("canonicalizes once and refuses ambiguous URLs", () => {
    const ok = (url: string, mode: "navigate" | "subresource" = "navigate") => matchPublicBrowserUrl(MANIFEST.targets, url, mode) !== null;
    expect(ok("https://docs.example.test/guide")).toBe(true);
    expect(ok("https://docs.example.test/guide/intro?page=2")).toBe(true);
    expect(ok("https://docs.example.test/guidebook")).toBe(false);
    expect(ok("https://docs.example.test/guide?token=abc")).toBe(false);
    expect(ok("https://docs.example.test/guide?page=1&page=2")).toBe(false);
    expect(ok("https://docs.example.test/guide%2f..%2fadmin")).toBe(false);
    expect(ok("https://docs.example.test./guide")).toBe(false);
    expect(ok("https://DOCS.example.test/guide")).toBe(true);
    expect(ok("https://docs.example.test:443/guide")).toBe(true);
    expect(ok("https://docs.example.test:8443/guide")).toBe(false);
    expect(ok("https://user:pw@docs.example.test/guide")).toBe(false);
    expect(ok("https://127.0.0.1/guide")).toBe(false);
    expect(ok("https://[::1]/guide")).toBe(false);
    expect(ok("https://cdn.example.test/app.js")).toBe(false);
    expect(ok("https://cdn.example.test/app.js", "subresource")).toBe(true);
  });
});

describe("public browser runtime start", () => {
  it("starts only with a signed approval for the current catalog, internet off, interception installed before launch", async () => {
    const f = fixture();
    const approval = await f.approve();
    await expect(f.runtime().startBrowser({ ...approval, signature: "0".repeat(64) })).rejects.toThrow("public_browser_approval_invalid");
    await expect(f.runtime().startBrowser(await f.approve({ digest: "d".repeat(64) }))).rejects.toThrow("public_browser_catalog_changed");
    expect(f.container.starts).toHaveLength(0);
    await f.runtime().startBrowser(approval);
    await expect(f.runtime().startBrowser(approval)).rejects.toThrow("public_browser_attempt_already_consumed");
    expect(f.container.starts).toEqual([{ image: IMAGE, instance: "standard-1", enableInternet: false,
      env: { SHIBA_BROWSER_EXPIRES_AT: String(approval.body.sessionExpiresAt), SHIBA_BROWSER_START_URL: MANIFEST.startUrl }, labels: { purpose: "public-browser", session: SESSION } }]);
    expect(f.container.intercepts.map(([kind]) => kind)).toEqual(["http", "https:*"]);
    expect(f.container.execs).toEqual([{ argv: ["/usr/local/bin/shiba-browser-ready"], intercepts: 2 }]);
  });
  it("destroys the attempt when interception cannot be installed", async () => {
    const f = fixture(); f.container.failIntercept = true;
    await expect(f.runtime().startBrowser(await f.approve())).rejects.toThrow("public_browser_start_failed");
    expect(f.container.destroyed).toBe(1);
    expect(f.container.execs).toHaveLength(0);
  });
  it("is unavailable while the flag is off even with a valid-looking capsule", async () => {
    const on = fixture(), approval = await on.approve();
    const off = fixture({ SHIBA_PUBLIC_BROWSER: "0" });
    await expect(off.runtime().startBrowser(approval)).rejects.toThrow("public_browser_disabled");
    expect(off.container.starts).toHaveLength(0);
  });
});

describe("public browser outbound security", () => {
  it("refuses unapproved hosts, schemes, ports, methods and modes before any upstream contact", async () => {
    const f = fixture(), container = await f.started();
    const refused = [
      ["https://evil.example.test/", {}], ["https://docs.example.test.evil.test/guide", {}], ["http://docs.example.test/guide", {}],
      ["https://docs.example.test:8443/guide", {}], ["https://127.0.0.1/guide", {}], ["https://169.254.169.254/latest/meta-data", {}],
      ["https://docs.example.test/admin", {}], ["https://docs.example.test/guide?session=secret", {}],
      ["https://docs.example.test/guide", { method: "POST", body: "x" }], ["https://docs.example.test/guide", { method: "PUT", body: "x" }],
      ["https://cdn.example.test/app.js", { headers: { "sec-fetch-mode": "navigate" } }],
    ] as const;
    for (const [url, init] of refused) expect((await container.request(url, init as RequestInit)).status).toBe(403);
    expect(f.upstream).toHaveLength(0);
  });
  it("forwards approved GETs without credentials and drops Set-Cookie", async () => {
    const f = fixture(), container = await f.started();
    const response = await container.request("https://docs.example.test/guide?page=2", { headers: { "sec-fetch-mode": "navigate", cookie: "sid=1", authorization: "Bearer x", referer: "https://docs.example.test/", origin: "https://docs.example.test", "x-shiba-token": "t", accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>ok</p>");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.upstream).toHaveLength(1);
    const sent = f.upstream[0]!;
    expect(sent.url).toBe("https://docs.example.test/guide?page=2");
    expect([...sent.headers.keys()].sort()).toEqual(["accept"]);
    expect(sent.redirect).toBe("manual");
  });
  it("rechecks redirects as fresh requests", async () => {
    const f = fixture(), container = await f.started();
    f.respond(() => new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }));
    const redirect = await container.request("https://docs.example.test/guide", { headers: { "sec-fetch-mode": "navigate" } });
    expect(redirect.status).toBe(302);
    expect((await container.request(redirect.headers.get("location")!, { headers: { "sec-fetch-mode": "navigate" } })).status).toBe(403);
    expect(f.upstream).toHaveLength(1);
  });
  it("STOP and catalog withdrawal fence later requests", async () => {
    const f = fixture(), container = await f.started();
    expect((await container.request("https://docs.example.test/guide")).status).toBe(200);
    f.env.SHIBA_PUBLIC_BROWSER_CATALOG = JSON.stringify({ ...MANIFEST, catalogRevision: "fixture-2" });
    expect(await (await container.request("https://docs.example.test/guide")).text()).toBe("public_browser_policy_withdrawn");
    expect(container.destroyed).toBe(1);
    const g = fixture(), other = await g.started();
    await g.runtime().stopBrowser(SESSION);
    expect(await (await other.request("https://docs.example.test/guide")).text()).toBe("public_browser_generation_fenced");
    expect(g.upstream).toHaveLength(0);
  });
  it("enforces request and response byte budgets", async () => {
    const f = fixture(), container = await f.started();
    f.respond(() => new Response("x".repeat(2_097_153)));
    await expect((await container.request("https://docs.example.test/guide")).text()).rejects.toThrow();
    f.respond(() => new Response("x", { headers: { "content-length": "99999999" } }));
    expect((await container.request("https://docs.example.test/guide")).status).toBe(502);
    f.respond(() => new Response("ok"));
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await container.request("https://docs.example.test/guide")).status;
    expect(last).toBe(403);
    expect(f.upstream.length).toBeLessThanOrEqual(5);
  });
});

describe("dedicated public browser image", () => {
  it("runs Chromium as a non-root user with its sandbox and trusts the interception CA only at runtime", () => {
    const docker = file("../Dockerfile.public-browser"), entry = file("../public-browser/entrypoint.sh"), ready = file("../public-browser/ready.sh");
    expect(docker).toMatch(/^USER browser$/m);
    expect(docker).not.toMatch(/COPY[^\n]*(?:proxy_ca|cloudflare-containers-ca|auth\.json|\.env|\.ssh)|ENV[^\n]*(?:TOKEN|SECRET|API_KEY)|^EXPOSE\s/m);
    expect(entry).not.toContain("--no-sandbox");
    expect(entry).toContain('[ "$(id -u)" -ne 0 ] || exit 65');
    expect(entry).toContain("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(entry).toContain("--disable-quic");
    expect(entry).not.toMatch(/(?:\bcurl\b|\bwget\b|\bnpm\b|\bclaude\b|\bcodex\b|x11vnc|websockify|remote-debugging-port)/);
    expect(ready).toContain("--no-sandbox' || exit 73");
    expect(JSON.parse(file("../public-browser/policy.json"))).toMatchObject({ DownloadRestrictions: 3, DnsOverHttpsMode: "off", ExtensionInstallBlocklist: ["*"] });
  });
});
