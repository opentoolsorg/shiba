import { deliverableByteLimit, isSafeDeliverablePath } from "@shiba/shared";
import { deliverableResponse } from "./deliverable-response.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

type Publication = { token: string; path: string; sha256: string; byte_count: number };
type Source = { path: string; sha256: string; bytes: number };
const link = (token: string) => `/share/p/${token}`;
const snapshot = (token: string) => `published-deliverables/${token}`;
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
const unavailable = () => json({ error: "Published deliverable not found." }, 404);
export const isPublishableDeliverable = (path: string) => /\.(html|pdf)$/i.test(path);

export async function verifiedDeliverableBytes(object: R2ObjectBody, source: Source): Promise<ArrayBuffer | null> {
  if (object.size !== source.bytes) return null;
  const body = await object.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return body.byteLength === source.bytes && hash === source.sha256 ? body : null;
}

export async function manageDeliverablePublication(
  env: Env,
  request: Request,
  scope: readonly [ownerSession: string, runId: string, index: number],
  source?: Source,
  body?: ArrayBuffer,
): Promise<Response> {
  if (!env.AGENT_AUDIT || !env.ATTACHMENTS) return json({ error: "Publishing is unavailable." }, 503);
  const where = "WHERE owner_session=? AND run_id=? AND artifact_index=?";
  if (request.method === "DELETE") {
    const removed = await env.AGENT_AUDIT.prepare(`DELETE FROM published_deliverables ${where} AND token=? RETURNING token`)
      .bind(...scope, request.headers.get("If-Match")?.match(/^"([a-f0-9]{64})"$/)?.[1] ?? "").first<{ token: string }>();
    if (!removed) return json({ error: "This link changed. Reload before revoking it." }, 409);
    await env.ATTACHMENTS.delete(snapshot(removed.token)).catch(() => {});
    return json({ path: null });
  }
  const read = () => env.AGENT_AUDIT.prepare(`SELECT token, sha256 FROM published_deliverables ${where}`)
    .bind(...scope).first<Pick<Publication, "token" | "sha256">>();
  const current = await read();
  if (request.method === "GET") return json({ path: current ? link(current.token) : null });
  if (!source || !body) return unavailable();
  if (request.headers.get("If-Match") !== `"${source.sha256}"`)
    return json({ error: "The deliverable changed. Reload before publishing it." }, 409);
  if (current) return current.sha256 === source.sha256
    ? json({ path: link(current.token) })
    : json({ error: "Revoke the existing link before publishing a different version." }, 409);

  const token = randomHex(32);
  const key = snapshot(token);
  const stored = await env.ATTACHMENTS.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } });
  if (!stored) return json({ error: "Could not save the published snapshot." }, 503);
  const inserted = await env.AGENT_AUDIT.prepare(
    `INSERT INTO published_deliverables (owner_session, run_id, artifact_index, token, path, sha256, byte_count)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM retired_deliverable_publication_sessions WHERE owner_session=?)
     ON CONFLICT(owner_session, run_id, artifact_index) DO NOTHING RETURNING token`,
  ).bind(...scope, token, source.path, source.sha256, source.bytes, scope[0]).first<{ token: string }>();
  if (inserted) return json({ path: link(inserted.token) }, 201);
  await env.ATTACHMENTS.delete(key).catch(() => {});
  const winner = await read();
  return winner?.sha256 === source.sha256
    ? json({ path: link(winner.token) })
    : json({ error: "Publication changed. Reload and try again." }, 409);
}

export async function revokeSessionDeliverablePublications(env: Env, ownerSession: string): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  const [, removed] = await env.AGENT_AUDIT.batch<{ token: string }>([
    env.AGENT_AUDIT.prepare("INSERT OR IGNORE INTO retired_deliverable_publication_sessions VALUES (?)").bind(ownerSession),
    env.AGENT_AUDIT.prepare("DELETE FROM published_deliverables WHERE owner_session=? RETURNING token").bind(ownerSession),
  ]);
  const keys = removed?.results.map(({ token }) => snapshot(token)) ?? [];
  if (keys.length) await env.ATTACHMENTS?.delete(keys).catch(() => {});
}

export async function readPublishedDeliverable(env: Env, token: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(token) || !env.AGENT_AUDIT || !env.ATTACHMENTS) return unavailable();
  const row = await env.AGENT_AUDIT.prepare("SELECT path, sha256, byte_count FROM published_deliverables WHERE token=?")
    .bind(token).first<Omit<Publication, "token">>();
  if (!row || !isSafeDeliverablePath(row.path) || !isPublishableDeliverable(row.path) ||
      row.byte_count < 1 || row.byte_count > deliverableByteLimit(row.path)) return unavailable();
  const object = await env.ATTACHMENTS.get(snapshot(token));
  const body = object && await verifiedDeliverableBytes(object, { bytes: row.byte_count, path: row.path, sha256: row.sha256 });
  if (!body) return unavailable();
  const active = await env.AGENT_AUDIT.prepare("SELECT 1 FROM published_deliverables WHERE token=?").bind(token).first();
  if (!active) return unavailable();
  return deliverableResponse(row.path, body, { inline: true, published: true }, {
    ...headers, "Cross-Origin-Opener-Policy": "same-origin", "X-Robots-Tag": "noindex, nofollow",
  });
}
