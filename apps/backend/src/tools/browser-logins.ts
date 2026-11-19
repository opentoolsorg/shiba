import { z } from "zod";
import type { Env } from "../env.js";
import { decryptSecret, encryptSecret, type VaultEnv } from "../vault.js";
import { assertPublicBrowserUrl } from "./browser-url.js";

export const loginIdSchema = z.string().regex(/^bl_[a-f0-9]{32}$/);
const originSchema = z.string().max(300).transform((value, ctx) => {
  try {
    const url = assertPublicBrowserUrl(value.trim());
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash ||
        url.username || url.password || url.hostname.includes("*") ||
        !/^https:\/\/[^/?#]+\/?$/i.test(value.trim())) throw new Error();
    return url.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: "Enter an exact public HTTPS origin, without a path, query or wildcard." });
    return z.NEVER;
  }
});

const totpSchema = z.string().max(256).transform((value) => value.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, ""))
  .pipe(z.string().regex(/^[A-Z2-7]{16,128}$/));
export const browserLoginCreateSchema = z.strictObject({
  origin: originSchema,
  label: z.string().trim().min(1).max(120),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(2048),
  totpSecret: totpSchema.nullable().optional(),
});
export const browserLoginUpdateSchema = browserLoginCreateSchema.partial().refine((input) => Object.keys(input).length > 0);
type LoginInput = z.output<typeof browserLoginCreateSchema>;

export interface BrowserLoginScope {
  kind: "personal" | "workspace";
  id: string;
}

interface LoginMetadata {
  id: string;
  label: string;
  origin: string;
  username: string;
  updated_at: number;
  revision: number;
}

interface LoginRow extends LoginMetadata {
  password_ciphertext: string;
  totp_ciphertext: string | null;
}

type LoginEnv = { AGENT_AUDIT: D1Database } & VaultEnv;
const metadataColumns = "id, label, origin, username, updated_at, revision";
const purpose = "browser-login";

function loginDto(row: LoginMetadata) {
  return { id: row.id, label: row.label, origin: row.origin, username: row.username, updatedAt: row.updated_at };
}

function aad(scope: BrowserLoginScope, id: string, origin: string, field: "password" | "totp") {
  return { aad: new TextEncoder().encode(JSON.stringify([purpose, scope.kind, scope.id, id, origin, field])) };
}

function readMetadata(db: D1Database, scope: BrowserLoginScope, id: string) {
  return db.prepare(`SELECT ${metadataColumns} FROM browser_logins WHERE id = ? AND scope = ? AND scope_id = ?`)
    .bind(id, scope.kind, scope.id).first<LoginMetadata>();
}

export async function listBrowserLogins(db: D1Database, scope: BrowserLoginScope) {
  const { results } = await db.prepare(`SELECT ${metadataColumns} FROM browser_logins WHERE scope = ? AND scope_id = ? ORDER BY updated_at DESC, id`)
    .bind(scope.kind, scope.id).all<LoginMetadata>();
  return results.map(loginDto);
}

export async function getBrowserLogin(db: D1Database, scope: BrowserLoginScope, id: string) {
  const row = await readMetadata(db, scope, id);
  return row && loginDto(row);
}

export async function createBrowserLogin(env: LoginEnv, scope: BrowserLoginScope, input: LoginInput) {
  const id = `bl_${crypto.randomUUID().replaceAll("-", "")}`;
  const { label, origin, username, password, totpSecret } = input;
  const updated_at = Date.now();
  const encryptedPassword = await encryptSecret(password, env, purpose, aad(scope, id, origin, "password"));
  const encryptedTotp = totpSecret ? await encryptSecret(totpSecret, env, purpose, aad(scope, id, origin, "totp")) : null;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO browser_logins (id, scope, scope_id, label, origin, username, updated_at, password_ciphertext, totp_ciphertext)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, scope.kind, scope.id, label, origin, username, updated_at, encryptedPassword, encryptedTotp).run();
  return loginDto({ id, label, origin, username, updated_at, revision: 1 });
}

export async function updateBrowserLogin(env: LoginEnv, scope: BrowserLoginScope, id: string, input: Partial<LoginInput>) {
  const row = await readMetadata(env.AGENT_AUDIT, scope, id);
  if (!row) return null;
  const origin = input.origin ?? row.origin;
  if (origin !== row.origin && (!input.password || input.totpSecret === undefined)) {
    throw new BrowserLoginUpdateError("Changing the origin requires entering a new password and replacing or clearing the TOTP secret.");
  }
  const encryptedPassword = input.password === undefined ? null
    : await encryptSecret(input.password, env, purpose, aad(scope, id, origin, "password"));
  const encryptedTotp = input.totpSecret ? await encryptSecret(input.totpSecret, env, purpose, aad(scope, id, origin, "totp")) : null;
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE browser_logins SET label = COALESCE(?, label), origin = COALESCE(?, origin), username = COALESCE(?, username),
      password_ciphertext = COALESCE(?, password_ciphertext),
      totp_ciphertext = CASE WHEN ? THEN ? ELSE totp_ciphertext END, updated_at = ?, revision = revision + 1
     WHERE id = ? AND scope = ? AND scope_id = ? AND revision = ?`,
  ).bind(input.label ?? null, input.origin ?? null, input.username ?? null, encryptedPassword, Number(input.totpSecret !== undefined),
    encryptedTotp, Date.now(), id, scope.kind, scope.id, row.revision).run();
  if (!result.meta.changes) throw new BrowserLoginUpdateError("The saved login changed. Reload and try again.");
  return getBrowserLogin(env.AGENT_AUDIT, scope, id);
}

export class BrowserLoginUpdateError extends Error {}

export async function deleteBrowserLogin(db: D1Database, scope: BrowserLoginScope, id: string) {
  const result = await db.prepare("DELETE FROM browser_logins WHERE id = ? AND scope = ? AND scope_id = ?")
    .bind(id, scope.kind, scope.id).run();
  return Boolean(result.meta.changes);
}

export async function browserLoginIntent(env: Pick<Env, "AGENT_AUDIT">, scope: BrowserLoginScope, id: string) {
  const row = env.AGENT_AUDIT && await readMetadata(env.AGENT_AUDIT, scope, id);
  return row ? { id, origin: row.origin, revision: row.revision } : null;
}

export async function browserLoginWorkspace(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT scope_id FROM browser_logins WHERE id = ? AND scope = 'workspace'")
    .bind(id).first<{ scope_id: string }>();
  return row?.scope_id ?? null;
}

export async function decryptBrowserLogin(env: LoginEnv, scope: BrowserLoginScope, intent: { id: string; origin: string; revision: number }) {
  const { id, origin, revision } = intent;
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT ${metadataColumns}, password_ciphertext, totp_ciphertext FROM browser_logins
     WHERE id = ? AND scope = ? AND scope_id = ? AND origin = ? AND revision = ?`,
  ).bind(id, scope.kind, scope.id, origin, revision).first<LoginRow>();
  if (!row) return null;
  return {
    label: row.label,
    username: row.username,
    password: await decryptSecret(row.password_ciphertext, env, purpose, aad(scope, id, origin, "password")),
    totpSecret: row.totp_ciphertext ? await decryptSecret(row.totp_ciphertext, env, purpose, aad(scope, id, origin, "totp")) : null,
  };
}
