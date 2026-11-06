import { DurableObject } from "cloudflare:workers";
import { matchPublicBrowserUrl, PUBLIC_BROWSER_LIMITS as LIMIT } from "@shiba/shared";
import type { Env } from "./env.js";
import { PublicBrowserApproval, PublicBrowserError, PublicBrowserPolicy, PUBLIC_BROWSER_SESSION_ID, type PublicBrowserOutboundClaim, type PublicBrowserOutboundGrant } from "./public-browser.js";
import type { PublicBrowserOutboundProps } from "./public-browser-outbound.js";

interface BrowserCtx extends DurableObjectState {
  readonly exports: { readonly PublicBrowserOutbound: (opts: { props: PublicBrowserOutboundProps }) => Fetcher };
}
interface SessionRow { id: string; digest: string; generation: number; state: "starting" | "active" | "stopped"; expires_at: number; requests: number; bytes: number; denied: number }
const MAX_PROCESS_BYTES = 4096;

/** One disposable public browser per DO. Never a coding sandbox, never the offline desktop, never agent-controlled. */
export class PublicBrowserSession extends DurableObject<Env> {
  #container: Container | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); this.#container = ctx.container;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS public_browser_session(id TEXT PRIMARY KEY, digest TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL, expires_at INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0)`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS public_browser_once(id TEXT PRIMARY KEY)");
  }
  async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
  #row(): SessionRow | undefined { return this.ctx.storage.sql.exec("SELECT * FROM public_browser_session LIMIT 1").toArray()[0] as SessionRow | undefined; }
  #bound(id: string) {
    const namespace = this.env.PublicBrowserSession;
    if (!PUBLIC_BROWSER_SESSION_ID.test(id) || !namespace || !this.ctx.id.equals(namespace.idFromName(id))) throw new PublicBrowserError("public_browser_scope_invalid");
    if (!this.#container) throw new PublicBrowserError("public_browser_runtime_unavailable", 503);
    return this.#container;
  }
  async #process(container: Container, argv: string[], timeoutMs: number) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const process = await container.exec(argv, { env: { DISPLAY: ":1", PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", signal: controller.signal });
      const drain = async (stream: ReadableStream | null | undefined) => {
        if (!stream) return; const reader = stream.getReader(); let bytes = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_PROCESS_BYTES) { process.kill(9); throw new PublicBrowserError("public_browser_process_output_limit", 503); } } }
        finally { await reader.cancel().catch(() => {}); }
      };
      const [, , exit] = await Promise.all([drain(process.stdout), drain(process.stderr), process.exitCode]);
      if (exit !== 0) throw new PublicBrowserError("public_browser_not_ready", 503);
    } finally { clearTimeout(timer); }
  }
  async startBrowser(raw: unknown): Promise<void> {
    const approval = await PublicBrowserApproval.verify(this.env, raw), id = approval.sessionId, container = this.#bound(id);
    const policy = (await PublicBrowserPolicy.read(this.env)).require(), now = Date.now();
    if (approval.digest !== policy.digest) throw new PublicBrowserError("public_browser_catalog_changed");
    if (approval.sessionExpiresAt <= now || approval.sessionExpiresAt > now + LIMIT.ttlMs) throw new PublicBrowserError("public_browser_expiry_invalid", 400);
    if (this.ctx.storage.sql.exec("INSERT OR IGNORE INTO public_browser_once(id) VALUES(?)", approval.id).rowsWritten !== 1 || this.#row() || container.running) throw new PublicBrowserError("public_browser_attempt_already_consumed", 409);
    // Durable before allocation: an uncertain start is destroyed, never replayed.
    this.ctx.storage.sql.exec("INSERT INTO public_browser_session(id,digest,generation,state,expires_at) VALUES(?,?,1,'starting',?)", id, policy.digest, approval.sessionExpiresAt);
    await this.ctx.storage.setAlarm(Math.min(now + 1000, approval.sessionExpiresAt));
    // enableInternet stays false: only the intercepted HTTP/HTTPS paths below exist. No Worker credential is passed.
    container.start({ image: policy.image, instance: "standard-1", enableInternet: false,
      env: { SHIBA_BROWSER_EXPIRES_AT: String(approval.sessionExpiresAt), SHIBA_BROWSER_START_URL: policy.manifest.startUrl }, labels: { purpose: "public-browser", session: id } });
    try {
      const outbound = (this.ctx as BrowserCtx).exports.PublicBrowserOutbound({ props: { sessionId: id, generation: 1 } });
      await container.interceptAllOutboundHttp(outbound);
      await container.interceptOutboundHttps("*", outbound);
      await container.setInactivityTimeout(30_000);
      // The image launches Chromium only after this release signal, i.e. after interception is installed.
      await this.#process(container, ["/usr/local/bin/shiba-browser-ready"], 30_000);
      if (this.ctx.storage.sql.exec("UPDATE public_browser_session SET state='active' WHERE id=? AND state='starting' AND generation=1", id).rowsWritten !== 1) throw new PublicBrowserError("public_browser_generation_fenced");
    } catch (error) {
      await this.#destroy(id).catch(() => {});
      throw error instanceof PublicBrowserError ? error : new PublicBrowserError("public_browser_start_failed", 503);
    }
  }
  /** Called by PublicBrowserOutbound for every request. Reserves budget before any upstream contact. */
  async authorizeOutbound(sessionId: string, generation: number, claim: PublicBrowserOutboundClaim): Promise<PublicBrowserOutboundGrant> {
    const refuse = (code: string): PublicBrowserOutboundGrant => { this.ctx.storage.sql.exec("UPDATE public_browser_session SET denied=denied+1 WHERE id=?", sessionId); return { ok: false, code }; };
    const live = () => { const row = this.#row(); return row && row.id === sessionId && row.state === "active" && row.generation === generation ? row : undefined; };
    if (!live()) return { ok: false, code: "public_browser_generation_fenced" };
    const policy = await PublicBrowserPolicy.read(this.env);
    const row = live();
    if (!row) return { ok: false, code: "public_browser_generation_fenced" };
    if (Date.now() >= row.expires_at) { await this.#destroy(sessionId); return { ok: false, code: "public_browser_expired" }; }
    if (!policy.available || policy.digest !== row.digest || !policy.manifest) { await this.#destroy(sessionId); return { ok: false, code: "public_browser_policy_withdrawn" }; }
    if (claim.method !== "GET" && claim.method !== "HEAD") return refuse("public_browser_method_refused");
    const match = matchPublicBrowserUrl(policy.manifest.targets, claim.url, claim.mode);
    if (!match) return refuse("public_browser_destination_refused");
    if (row.requests >= LIMIT.maxRequests || row.bytes >= LIMIT.maxTotalResponseBytes) return refuse("public_browser_budget_exhausted");
    // Conservative charge: the full per-response reservation is spent whether or not it is used.
    const maxBytes = Math.min(LIMIT.maxResponseBytes, LIMIT.maxTotalResponseBytes - row.bytes);
    const reserved = this.ctx.storage.sql.exec("UPDATE public_browser_session SET requests=requests+1,bytes=bytes+? WHERE id=? AND generation=? AND state='active' AND requests=?", maxBytes, sessionId, generation, row.requests);
    if (reserved.rowsWritten !== 1) return refuse("public_browser_budget_race");
    return { ok: true, url: match.url.href, maxBytes };
  }
  async stopBrowser(sessionId: string): Promise<void> { this.#bound(sessionId); await this.#destroy(sessionId); }
  async #destroy(id: string): Promise<void> {
    // Synchronous fence precedes every await: later requests and a pending start see a retired generation.
    this.ctx.storage.sql.exec("UPDATE public_browser_session SET state='stopped',generation=generation+1 WHERE id=? AND state<>'stopped'", id);
    const container = this.#container;
    if (container?.running) await container.destroy();
    await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    const row = this.#row(); if (!row || row.state === "stopped") return;
    const policy = await PublicBrowserPolicy.read(this.env);
    if (Date.now() >= row.expires_at || policy.digest !== row.digest || !policy.available) { await this.#destroy(row.id); return; }
    await this.ctx.storage.setAlarm(Math.min(Date.now() + 1000, row.expires_at));
  }
}
