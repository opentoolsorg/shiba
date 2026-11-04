import type { Env } from "./env.js";

const DOWNLOAD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 8_500_000;
const MAX_TOKEN_LENGTH = 2048;
const MAX_DOWNLOAD_BODY_BYTES = MAX_TOKEN_LENGTH + "token=".length;
const DOWNLOAD_PATH = "/api/artifacts/download";

export interface ArtifactDownloadClaims {
  version: 1;
  /** SHA-256 of the owning orchestrator, run and sandbox tuple. */
  scope: string;
  sha256: string;
  bytes: number;
  fileCount: number;
  issuedAt: number;
  expiresAt: number;
}

type SigningEnv = Pick<Env, "ARTIFACT_SIGNING_KEY" | "WORKER_HOSTNAME">;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid artifact download token.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (base64url(decoded) !== value) throw new Error("Invalid artifact download token.");
  return decoded;
}

function validClaims(value: unknown): value is ArtifactDownloadClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return Object.keys(claims).length === 7 && claims.version === 1 &&
    typeof claims.scope === "string" && /^[a-f0-9]{64}$/.test(claims.scope) &&
    typeof claims.sha256 === "string" && /^[a-f0-9]{64}$/.test(claims.sha256) &&
    typeof claims.bytes === "number" && Number.isSafeInteger(claims.bytes) && claims.bytes >= 22 && claims.bytes <= MAX_ARCHIVE_BYTES &&
    typeof claims.fileCount === "number" && Number.isInteger(claims.fileCount) && claims.fileCount >= 0 && claims.fileCount <= 64 &&
    typeof claims.issuedAt === "number" && Number.isSafeInteger(claims.issuedAt) && claims.issuedAt > 0 &&
    typeof claims.expiresAt === "number" && Number.isSafeInteger(claims.expiresAt) &&
    claims.expiresAt > claims.issuedAt && claims.expiresAt - claims.issuedAt <= DOWNLOAD_LIFETIME_MS;
}

async function signingKey(env: SigningEnv): Promise<CryptoKey> {
  const secret = env.ARTIFACT_SIGNING_KEY;
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) throw new Error("Workspace artifact signing requires a secret of at least 32 bytes.");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function artifactDownloadOrigin(env: SigningEnv): URL {
  const configured = env.WORKER_HOSTNAME?.trim();
  if (!configured) throw new Error("Workspace artifact downloads require WORKER_HOSTNAME.");
  const origin = new URL(configured.includes("://") ? configured : `https://${configured}`);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Workspace artifact downloads require an HTTPS Worker origin.");
  }
  return origin;
}

/** Fail before sandbox execution if its output cannot be retained and delivered. */
export function assertWorkspaceArtifactConfiguration(env: SigningEnv & Pick<Env, "ARTIFACTS">): asserts env is SigningEnv & { ARTIFACTS: R2Bucket } {
  if (!env.ARTIFACTS) throw new Error("Workspace artifact storage is not configured.");
  if (!env.ARTIFACT_SIGNING_KEY || new TextEncoder().encode(env.ARTIFACT_SIGNING_KEY).byteLength < 32) {
    throw new Error("Workspace artifact signing requires a secret of at least 32 bytes.");
  }
  artifactDownloadOrigin(env);
}

/** The fragment reaches the recipient's browser, never the HTTP request URL. */
export async function createArtifactDownloadUrl(env: SigningEnv, claims: ArtifactDownloadClaims): Promise<string> {
  if (!validClaims(claims)) throw new Error("Invalid workspace archive download claims.");
  const origin = artifactDownloadOrigin(env);
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(`shiba-artifact-download:v1:${encoded}`));
  const url = new URL(DOWNLOAD_PATH, origin);
  url.searchParams.set("landing", "1");
  url.hash = new URLSearchParams({ token: `${encoded}.${base64url(new Uint8Array(signature))}` }).toString();
  return url.toString();
}

export async function verifyArtifactDownloadToken(
  env: SigningEnv,
  token: string,
  now = Date.now(),
): Promise<ArtifactDownloadClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const signature = fromBase64url(parts[1]);
    if (signature.byteLength !== 32) return null;
    const verified = await crypto.subtle.verify("HMAC", await signingKey(env), signature, new TextEncoder().encode(`shiba-artifact-download:v1:${parts[0]}`));
    if (!verified) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(parts[0])));
    if (!validClaims(value) || value.issuedAt > now || value.expiresAt <= now) return null;
    return value;
  } catch {
    return null;
  }
}

function privateHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
}

function downloadError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: privateHeaders() });
}

/** Public instructions only: no claims, capability or artifact data is reflected. */
function downloadLanding(): Response {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Download Shiba artifacts</title></head>
<body><main><h1>Download artifacts</h1><p id="status" role="status">JavaScript is required to open this private download link.</p>
<form action="${DOWNLOAD_PATH}" method="post" autocomplete="off"><input id="token" type="hidden" name="token"><button type="submit" disabled>Download artifacts.zip</button></form>
<p>The link expires seven days after creation. Anyone with the complete link can download this archive.</p></main>
<script nonce="${nonce}">
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const values = [...fragment.entries()];
const token = values.length === 1 && values[0][0] === "token" ? values[0][1] : "";
if (token.length > 0 && token.length <= ${MAX_TOKEN_LENGTH} && /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(token)) {
  document.getElementById("token").value = token;
  document.querySelector("button").disabled = false;
  document.getElementById("status").textContent = "Your private download is ready. Select Download to retrieve the archive.";
} else {
  document.getElementById("status").textContent = "This download link is missing or invalid. Open the complete link from Shiba.";
}
</script></body></html>`, { headers: {
    ...privateHeaders(),
    "content-type": "text/html; charset=utf-8",
    // no-referrer makes browser form POSTs send Origin: null. Keep same-origin
    // attribution for the POST guard; the fragment is never a referrer and is
    // cleared before submission. Cross-origin destinations receive no referrer.
    "referrer-policy": "same-origin",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "cross-origin-opener-policy": "same-origin",
  } });
}

/** Bound the untrusted stream before parsing; never buffer an arbitrary request. */
async function postedDownloadToken(request: Request): Promise<string | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_DOWNLOAD_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_DOWNLOAD_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const fields = [...new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body)).entries()];
    return fields.length === 1 && fields[0]?.[0] === "token" ? fields[0][1] : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** This exact route authenticates only the signed, time-bound archive capability. */
export async function handleArtifactDownload(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== DOWNLOAD_PATH) return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...privateHeaders(), allow: "GET, POST" } });
  }
  const fields = [...url.searchParams.entries()];
  if (request.method === "GET" && fields.length === 1 && fields[0]?.[0] === "landing" && fields[0][1] === "1") return downloadLanding();
  let token: string | null = null;
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (url.search || (origin !== null && origin !== url.origin) || (site !== null && site !== "same-origin" && site !== "none")) {
      return downloadError("Invalid or expired artifact download.", 403);
    }
    token = await postedDownloadToken(request);
  } else {
    // Existing delivered links retain their original expiry (at most seven days).
    // They can still enter URL logs; only newly issued fragment links avoid that.
    token = fields.length === 1 && fields[0]?.[0] === "token" ? fields[0][1] : null;
  }
  const claims = token !== null ? await verifyArtifactDownloadToken(env, token) : null;
  if (!claims) return downloadError("Invalid or expired artifact download.", 403);
  if (!env.ARTIFACTS) return downloadError("Workspace artifact storage is unavailable.", 503);
  const object = await env.ARTIFACTS.get(`run-archives/${claims.scope}/${claims.sha256}.zip`);
  if (!object) return downloadError("Artifact not found.", 404);
  const digest = object.checksums?.sha256;
  const hash = digest ? Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") : null;
  if (object.size !== claims.bytes || hash !== claims.sha256 ||
      object.customMetadata?.scope !== claims.scope || object.customMetadata?.sha256 !== claims.sha256 ||
      object.customMetadata?.bytes !== String(claims.bytes) || object.customMetadata?.fileCount !== String(claims.fileCount)) {
    await object.body.cancel();
    return downloadError("Artifact integrity check failed.", 409);
  }
  return new Response(object.body, { headers: {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="artifacts.zip"',
    "content-length": String(claims.bytes),
    ...privateHeaders(),
  } });
}
