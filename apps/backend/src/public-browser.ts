import { PUBLIC_BROWSER_LIMITS as LIMIT, publicBrowserManifestSchema, type PublicBrowserManifest, type PublicBrowserRequestMode } from "@shiba/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import { hashToolArgs } from "./mcp-gateway.js";

export class PublicBrowserError extends Error { constructor(readonly code: string, readonly status = 403) { super(code); } }
export const PUBLIC_BROWSER_SESSION_ID = /^spb_[a-f0-9]{32}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]{1,300}@sha256:[a-f0-9]{64}$/;

/** Operator configuration for the separate public browser. Every missing piece reports unavailable; nothing falls back to offline. */
export class PublicBrowserPolicy {
  private constructor(readonly enabled: boolean, readonly reason: string | null, readonly image: string | null, readonly manifest: PublicBrowserManifest | null, readonly digest: string | null) {}
  get available() { return this.reason === null; }
  static async read(env: Env): Promise<PublicBrowserPolicy> {
    const enabled = env.SHIBA_PUBLIC_BROWSER === "1";
    const image = typeof env.SHIBA_PUBLIC_BROWSER_IMAGE === "string" && IMAGE.test(env.SHIBA_PUBLIC_BROWSER_IMAGE) ? env.SHIBA_PUBLIC_BROWSER_IMAGE : null;
    const manifest = PublicBrowserPolicy.#manifest(env.SHIBA_PUBLIC_BROWSER_CATALOG);
    const signing = typeof env.INTERNAL_SIGNING_KEY === "string" && env.INTERNAL_SIGNING_KEY.length >= 32;
    const reason = !enabled ? "public_browser_disabled" : !image ? "public_browser_image_unavailable"
      : image === env.SHIBA_SHARED_COMPUTER_IMAGE ? "public_browser_image_shared_with_offline" : !manifest ? "public_browser_catalog_unavailable"
      : !env.PublicBrowserSession ? "public_browser_runtime_unavailable" : !signing ? "public_browser_signing_unavailable" : null;
    return new PublicBrowserPolicy(enabled, reason, image, manifest, image && manifest ? await hashToolArgs({ image, manifest }) : null);
  }
  static #manifest(raw: string | undefined) {
    if (typeof raw !== "string" || !raw) return null;
    try { const parsed = publicBrowserManifestSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : null; } catch { return null; }
  }
  require() {
    if (!this.available || !this.image || !this.manifest || !this.digest) throw new PublicBrowserError(this.reason ?? "public_browser_unavailable", 503);
    return { image: this.image, manifest: this.manifest, digest: this.digest };
  }
}

const hash = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive();
const approvalSchema = z.object({ scope: z.literal("shiba.public-browser-start.v1"), id: z.string().uuid(), sessionId: z.string().regex(PUBLIC_BROWSER_SESSION_ID),
  digest: hash, approvedBy: z.string().email().max(254), sessionExpiresAt: positive, issuedAt: positive, expiresAt: positive }).strict();
export type PublicBrowserApprovalBody = z.infer<typeof approvalSchema>;
async function signingKey(env: Env) {
  if (!env.INTERNAL_SIGNING_KEY || env.INTERNAL_SIGNING_KEY.length < 32) throw new PublicBrowserError("public_browser_signing_unavailable", 503);
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.INTERNAL_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
/**
 * Backend-only, ten-second start capsule bound to one session and one manifest digest.
 * Only a native human review route may sign it; no route does yet.
 */
export class PublicBrowserApproval {
  static async sign(env: Env, input: Pick<PublicBrowserApprovalBody, "sessionId" | "digest" | "approvedBy" | "sessionExpiresAt">) {
    const issuedAt = Date.now(), body = approvalSchema.parse({ scope: "shiba.public-browser-start.v1", id: crypto.randomUUID(), ...input, issuedAt, expiresAt: issuedAt + 10_000 });
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(JSON.stringify(body))));
    return { body, signature: Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  }
  static async verify(env: Env, raw: unknown): Promise<PublicBrowserApprovalBody> {
    const parsed = z.object({ body: approvalSchema, signature: hash }).strict().safeParse(raw);
    if (!parsed.success) throw new PublicBrowserError("public_browser_approval_invalid");
    const { body, signature } = parsed.data, now = Date.now();
    if (body.issuedAt > now + 1000 || body.expiresAt <= now || body.expiresAt > body.issuedAt + 10_000) throw new PublicBrowserError("public_browser_approval_expired");
    const valid = await crypto.subtle.verify("HMAC", await signingKey(env), Uint8Array.from(signature.match(/../g)!, (pair) => Number.parseInt(pair, 16)), new TextEncoder().encode(JSON.stringify(body)));
    if (!valid) throw new PublicBrowserError("public_browser_approval_invalid");
    return body;
  }
}

export interface PublicBrowserOutboundClaim { url: string; method: string; mode: PublicBrowserRequestMode }
export type PublicBrowserOutboundGrant = { ok: true; url: string; maxBytes: number } | { ok: false; code: string };
// The renderer never chooses credentials, cookies, Referer or Origin.
const REQUEST_HEADERS = ["accept", "accept-language", "user-agent"];
const RESPONSE_HEADERS = ["content-type", "content-language", "location", "last-modified"];
const NO_BODY = new Set([204, 205, 304]);
function deny(code: string, status = 403) { return new Response(code, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }); }

/** Deny-by-default outbound decision: every request is authorized by the session before any upstream contact. */
export class PublicBrowserOutboundGate {
  constructor(private readonly authorize: (claim: PublicBrowserOutboundClaim) => Promise<PublicBrowserOutboundGrant>, private readonly upstream: (request: Request) => Promise<Response>) {}
  async handle(request: Request): Promise<Response> {
    if ((request.method !== "GET" && request.method !== "HEAD") || request.body || request.headers.has("content-length") || request.headers.has("transfer-encoding") || request.headers.has("upgrade")) return deny("public_browser_method_refused");
    // Sec-Fetch-Mode is renderer-supplied; it can only choose between modes the manifest already approves for that host.
    const mode = request.headers.get("sec-fetch-mode") === "navigate" ? "navigate" : "subresource";
    let grant: PublicBrowserOutboundGrant;
    try { grant = await this.authorize({ url: request.url, method: request.method, mode }); } catch { grant = { ok: false, code: "public_browser_policy_unavailable" }; }
    if (!grant.ok) return deny(grant.code);
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) { const value = request.headers.get(name); if (value && value.length <= 512) headers.set(name, value); }
    let response: Response;
    try { response = await this.upstream(new Request(grant.url, { method: request.method, headers, redirect: "manual", signal: AbortSignal.timeout(15_000) })); }
    catch { return deny("public_browser_upstream_unavailable", 502); }
    if (Number(response.headers.get("content-length") ?? 0) > grant.maxBytes) { await response.body?.cancel().catch(() => {}); return deny("public_browser_response_too_large", 502); }
    const out = new Headers({ "cache-control": "no-store" });
    for (const name of RESPONSE_HEADERS) { const value = response.headers.get(name); if (value) out.set(name, value); }
    const body = request.method === "HEAD" || NO_BODY.has(response.status) || !response.body ? null : PublicBrowserOutboundGate.#capped(response.body, grant.maxBytes);
    if (!body) await response.body?.cancel().catch(() => {});
    return new Response(body, { status: response.status, headers: out });
  }
  static #capped(body: ReadableStream<Uint8Array>, maxBytes: number) {
    let size = 0;
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes || size > LIMIT.maxResponseBytes) controller.error(new PublicBrowserError("public_browser_response_too_large", 502)); else controller.enqueue(chunk);
    } }));
  }
}
