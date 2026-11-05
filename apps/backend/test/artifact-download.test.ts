import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createArtifactDownloadUrl, handleArtifactDownload, verifyArtifactDownloadToken } from "../src/artifact-download.js";

const origin = "https://shiba.test";
const path = "/api/artifacts/download";
const signing = { ARTIFACT_SIGNING_KEY: "test-only-artifact-signing-key-at-least-32-bytes", WORKER_HOSTNAME: origin };
const rejectedBrowserHeaders: Record<string, string>[] = [
  { origin: "https://other.test" }, { origin: "null" }, { origin: `${origin}/` },
  { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
  { origin, "sec-fetch-site": "cross-site" },
];

async function fixture() {
  const bytes = new Uint8Array(22);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Buffer.from(digest).toString("hex");
  const now = Date.now();
  const claims = { version: 1 as const, scope: "a".repeat(64), sha256, bytes: bytes.byteLength, fileCount: 0,
    issuedAt: now, expiresAt: now + 604_800_000 };
  const get = vi.fn(async () => ({ size: bytes.byteLength, body: new Response(bytes).body,
    checksums: { sha256: digest }, customMetadata: { scope: claims.scope, sha256, bytes: String(bytes.byteLength), fileCount: "0" } }));
  const env = { ...signing, ARTIFACTS: { get } } as unknown as Env;
  const link = new URL(await createArtifactDownloadUrl(env, claims));
  const token = new URLSearchParams(link.hash.slice(1)).get("token")!;
  return { env, claims, link, token, get, bytes };
}

function posted(token: string, headers: HeadersInit = {}): Request {
  return new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams({ token }), headers });
}

function runLanding(html: string, hash: string) {
  const steps: string[] = [];
  const input = { value: "" };
  const button = { disabled: true };
  const status = { textContent: "" };
  const replaceState = vi.fn(() => { steps.push("clear-url"); });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Landing script missing.");
  runInNewContext(script, {
    URLSearchParams,
    location: { pathname: path, hash },
    history: { replaceState },
    document: {
      getElementById: (id: string) => { steps.push(`element:${id}`); return id === "token" ? input : status; },
      querySelector: () => button,
    },
  });
  return { input, button, status, replaceState, steps };
}

describe("private artifact capability transport", () => {
  it("keeps the seven-day capability out of HTTP URLs and landing HTML", async () => {
    const f = await fixture();
    expect(f.link.pathname).toBe(path);
    expect(f.link.search).toBe("?landing=1");
    expect(f.link.searchParams.has("token")).toBe(false);
    expect(f.link.hash).toContain("#token=");
    expect(await verifyArtifactDownloadToken(signing, f.token, f.claims.issuedAt)).toEqual(f.claims);
    expect(await verifyArtifactDownloadToken(signing, f.token, f.claims.expiresAt - 1)).toEqual(f.claims);
    expect(await verifyArtifactDownloadToken(signing, f.token, f.claims.expiresAt)).toBeNull();
    const requestUrl = new URL(f.link); requestUrl.hash = "";
    const response = await handleArtifactDownload(new Request(requestUrl), f.env);
    const html = await response!.text();
    expect(response?.status).toBe(200);
    expect(html).not.toContain(f.token);
    expect(html).not.toContain(f.claims.scope);
    expect(html).not.toContain(f.claims.sha256);
    expect(html).toContain(`action="${path}" method="post"`);
    const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(response?.headers.get("content-security-policy")).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("referrer-policy")).toBe("same-origin");
    expect(response?.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const browser = runLanding(html, f.link.hash);
    expect(browser.steps[0]).toBe("clear-url");
    expect(browser.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", path);
    expect(browser.input.value).toBe(f.token);
    expect(browser.button.disabled).toBe(false);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["", "#token=", "#token=invalid", "#token=a.b&token=c.d", "#token=a.b&extra=1", "#extra=a.b", `#token=${"a".repeat(2049)}.b`])("does not enable downloads for malformed browser fragment %s", async (hash) => {
    const f = await fixture();
    const response = await handleArtifactDownload(new Request(f.link), f.env);
    const browser = runLanding(await response!.text(), hash);
    expect(browser.replaceState).toHaveBeenCalledOnce();
    expect(browser.input.value).toBe("");
    expect(browser.button.disabled).toBe(true);
    expect(browser.status.textContent).toContain("missing or invalid");
    expect(f.get).not.toHaveBeenCalled();
  });

  it("downloads only after the same-origin POST carries a valid capability", async () => {
    const f = await fixture();
    const response = await handleArtifactDownload(posted(f.token, { origin, "sec-fetch-site": "same-origin" }), f.env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/zip");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response?.headers.get("content-disposition")).toBe('attachment; filename="artifacts.zip"');
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(f.bytes);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(`run-archives/${f.claims.scope}/${f.claims.sha256}.zip`);
  });

  it("preserves already issued query links until their original expiry", async () => {
    const f = await fixture();
    const legacy = new URL(`${origin}${path}`); legacy.searchParams.set("token", f.token);
    expect((await handleArtifactDownload(new Request(legacy), f.env))?.status).toBe(200);
    expect(f.get).toHaveBeenCalledOnce();
  });

  it.each(rejectedBrowserHeaders)("rejects cross-origin browser posts before storage reads: %j", async (headers) => {
    const f = await fixture();
    expect((await handleArtifactDownload(posted(f.token, headers), f.env))?.status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["", "token=garbage", "token=a.b&token=c.d", "token=a.b&other=1", "other=a.b", `token=${"x".repeat(2049)}`])("rejects malformed posted fields before storage reads", async (body) => {
    const f = await fixture();
    const response = await handleArtifactDownload(new Request(`${origin}${path}`, { method: "POST", body,
      headers: { "content-type": "application/x-www-form-urlencoded" } }), f.env);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(f.get).not.toHaveBeenCalled();
  });

  it("bounds chunked request bytes before parsing and cancels an oversized stream", async () => {
    const f = await fixture();
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("token="));
      controller.enqueue(new Uint8Array(2049));
    }, cancel });
    const request = new Request(`${origin}${path}`, { method: "POST", body,
      headers: { "content-type": "application/x-www-form-urlencoded" }, duplex: "half" } as RequestInit);
    expect((await handleArtifactDownload(request, f.env))?.status).toBe(403);
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rejects ambiguous query/body authority, wrong content types and declared oversize", async () => {
    const f = await fixture();
    const wrongType = new Request(`${origin}${path}`, { method: "POST", body: f.token });
    const declared = posted(f.token, { "content-length": "999999" });
    const ambiguous = new Request(f.link, { method: "POST", body: new URLSearchParams({ token: f.token }) });
    const missing = new Request(`${origin}${path}`);
    const unexpected = new Request(`${origin}${path}?landing=1&token=${encodeURIComponent(f.token)}`);
    for (const request of [wrongType, declared, ambiguous, missing, unexpected]) {
      expect((await handleArtifactDownload(request, f.env))?.status).toBe(403);
    }
    expect(f.get).not.toHaveBeenCalled();
  });
});
