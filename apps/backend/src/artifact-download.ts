import type { Env } from "./env.js";

const DOWNLOAD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 8_500_000;

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

/** An explicit download capability. Provider credentials never appear in this URL. */
export async function createArtifactDownloadUrl(env: SigningEnv, claims: ArtifactDownloadClaims): Promise<string> {
  if (!validClaims(claims)) throw new Error("Invalid workspace archive download claims.");
  const origin = artifactDownloadOrigin(env);
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(`shiba-artifact-download:v1:${encoded}`));
  const url = new URL("/api/artifacts/download", origin);
  url.searchParams.set("token", `${encoded}.${base64url(new Uint8Array(signature))}`);
  return url.toString();
}

export async function verifyArtifactDownloadToken(
  env: SigningEnv,
  token: string,
  now = Date.now(),
): Promise<ArtifactDownloadClaims | null> {
  if (token.length > 2048) return null;
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

/** This route authenticates only the signed, time-bound archive capability. */
export async function handleArtifactDownload(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/artifacts/download") return null;
  if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET" } });
  const tokens = url.searchParams.getAll("token");
  const claims = tokens.length === 1 ? await verifyArtifactDownloadToken(env, tokens[0] ?? "") : null;
  if (!claims) return Response.json({ error: "Invalid or expired artifact download." }, { status: 403 });
  if (!env.ARTIFACTS) return Response.json({ error: "Workspace artifact storage is unavailable." }, { status: 503 });
  const object = await env.ARTIFACTS.get(`run-archives/${claims.scope}/${claims.sha256}.zip`);
  if (!object) return Response.json({ error: "Artifact not found." }, { status: 404 });
  const digest = object.checksums?.sha256;
  const hash = digest ? Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") : null;
  if (object.size !== claims.bytes || hash !== claims.sha256 ||
      object.customMetadata?.scope !== claims.scope || object.customMetadata?.sha256 !== claims.sha256 ||
      object.customMetadata?.bytes !== String(claims.bytes) || object.customMetadata?.fileCount !== String(claims.fileCount)) {
    await object.body.cancel();
    return Response.json({ error: "Artifact integrity check failed." }, { status: 409 });
  }
  return new Response(object.body, { headers: {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="artifacts.zip"',
    "content-length": String(claims.bytes),
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  } });
}
