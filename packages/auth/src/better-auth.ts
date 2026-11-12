/**
 * Built-in dashboard auth — email+password accounts with signed-cookie
 * sessions via Better Auth, the self-hosted alternative to Cloudflare
 * Access. Dark unless `BETTER_AUTH_SECRET` is set (the library requires
 * ≥32 chars; anything shorter reads as "not configured" and the gate fails
 * closed as before). Mounted at `/api/auth/*`; the subscription-connect
 * routes under `/api/auth/<provider>-subscription` keep their own surface
 * gate and are never claimed by this lane.
 *
 * Tables live in the `AGENT_AUDIT` D1 database alongside `audit_log` — the
 * same provisioned store, self-healed once per isolate exactly like
 * audit.ts (`ensureBetterAuthSchema` runs the idempotent DDL before any
 * auth work, so a fresh deployment needs no manual migration step).
 *
 * Sign-up defaults to bootstrap-only. A public deployment will not accept the first
 * account unless `BETTER_AUTH_BOOTSTRAP_TOKEN` is set; an owner email may
 * additionally restrict it. Loopback dev may create the first account without either.
 * Further sign-up requires an injected current-invitation validator, verified
 * email transport and a mounted restricted-member API policy. Invited accounts
 * never inherit the unverified bootstrap identity allowance.
 */
// better-auth loads on first use (see createBetterAuth): evaluating it at
// Worker startup pushed deploys past the startup CPU limit.
import { BOOTSTRAP_VERIFICATION_DDL, handleBootstrapVerification, type BootstrapVerificationAdapter } from "./bootstrap-verification.js";
export type { BootstrapVerificationAdapter } from "./bootstrap-verification.js";
import {
  ensureBetterAuthAccountPolicy, readBetterAuthAccountPolicy, recordBetterAuthAccountPolicy,
  type BetterAuthAccountPolicy,
} from "./better-auth-account-policy.js";
export type { BetterAuthAccountPolicy } from "./better-auth-account-policy.js";

/** The Worker owns invitations and transport. This package never imports its application. */
export interface BetterAuthEnrollmentAdapter {
  enabled: boolean;
  unavailableReason?: string;
  validateInvitation(input: { token: string; email: string }): Promise<{ invitationId: string; workspaceId: string } | null>;
  isEnrollmentCurrent(input: { invitationId: string; workspaceId: string; email: string }): Promise<boolean>;
  sendVerificationEmail(input: { email: string; url: string; request?: Request }): Promise<void>;
}
export const BETTER_AUTH_INVITATION_HEADER = "x-shiba-workspace-invitation";

/**
 * The lane reads only these env slots — the worker's `Env` satisfies it,
 * and tests can build the shape directly without the full env surface.
 */
export interface BetterAuthLaneEnv {
  AGENT_AUDIT?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_GOOGLE_CLIENT_ID?: string;
  BETTER_AUTH_GOOGLE_CLIENT_SECRET?: string;
  /** Slack OpenID sign-in credentials, separate from Slack app installation. */
  BETTER_AUTH_SLACK_CLIENT_ID?: string;
  BETTER_AUTH_SLACK_CLIENT_SECRET?: string;
  /** Required on a public host before the first account. */
  BETTER_AUTH_BOOTSTRAP_TOKEN?: string;
  /** Allowlisted email for the first account. Compared case-insensitively. */
  BETTER_AUTH_OWNER_EMAIL?: string;
}

/** Callers pass a redactor so package logs never carry secret material. */
export type SecretRedactor = (message: string) => string;

export const BETTER_AUTH_BASE_PATH = "/api/auth";
export const BETTER_AUTH_MIN_SECRET_LENGTH = 32;
/** Sent by the sign-up form. Never logged. */
export const BETTER_AUTH_BOOTSTRAP_HEADER = "x-shiba-bootstrap-token";
/** Bound on the auth handler so a stuck D1 call cannot leave the button spinning. */
export const AUTH_HANDLER_DEADLINE_MS = 12_000;

/** `/api/auth/<provider>-subscription*` belongs to the T47–T50 connect lanes. */
const SUBSCRIPTION_AUTH_PATH =
  /^\/api\/auth\/(?:claude|codex|cursor|antigravity)-subscription(?:\/|$)/;

export function isBetterAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith(`${BETTER_AUTH_BASE_PATH}/`) &&
    !SUBSCRIPTION_AUTH_PATH.test(pathname)
  );
}

export function isBetterAuthConfigured(env: {
  BETTER_AUTH_SECRET?: string;
}): boolean {
  return (
    typeof env.BETTER_AUTH_SECRET === "string" &&
    env.BETTER_AUTH_SECRET.length >= BETTER_AUTH_MIN_SECRET_LENGTH
  );
}

/**
 * Core Better Auth schema (sqlite) as emitted by `npx auth generate` for
 * 1.7.x — verbatim except `IF NOT EXISTS` so re-runs are no-ops.
 */
export const BETTER_AUTH_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL,
    "image" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATE NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATE,
    "refreshTokenExpiresAt" DATE,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATE NOT NULL,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")`,
  `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")`,
  `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")`,
  BOOTSTRAP_VERIFICATION_DDL,
];

/** D1/database handles whose auth schema is already ensured in this isolate. */
const schemaInitialized = new WeakSet<object>();

/** Apply the idempotent auth DDL once per isolate per binding. */
export async function ensureBetterAuthSchema(env: {
  AGENT_AUDIT: D1Database;
}): Promise<void> {
  const db = env.AGENT_AUDIT;
  if (schemaInitialized.has(db)) return;
  for (const statement of BETTER_AUTH_STATEMENTS) {
    await db.prepare(statement).run();
  }
  await ensureBetterAuthAccountPolicy(db);
  schemaInitialized.add(db);
}

/** A pending instance: concurrent first callers share one construction. */
type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
const instances = new WeakMap<BetterAuthLaneEnv, Map<BetterAuthEnrollmentAdapter | undefined, BetterAuthInstance>>();
const AUTH_OPERATION_HEADER = "x-shiba-internal-auth-operation";
const deliveryOperations = new Map<string, { failed: boolean }>();

// Local dev origins: the vite dev server (:5173) proxies /api to wrangler
// (:8788, sometimes :8787), so the browser's Origin differs from the
// request URL — both must be trusted for sign-in CSRF checks.
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8787",
  "http://localhost:8788",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8787",
  "http://127.0.0.1:8788",
];

function configuredSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Built-in providers only; never reuse integration/app-install credentials. */
function socialProviders(env: BetterAuthLaneEnv) {
  const googleId = configuredSecret(env.BETTER_AUTH_GOOGLE_CLIENT_ID);
  const googleSecret = configuredSecret(env.BETTER_AUTH_GOOGLE_CLIENT_SECRET);
  const slackId = configuredSecret(env.BETTER_AUTH_SLACK_CLIENT_ID);
  const slackSecret = configuredSecret(env.BETTER_AUTH_SLACK_CLIENT_SECRET);
  const policy = { disableSignUp: true, requireEmailVerification: true,
    overrideUserInfoOnSignIn: false };
  return {
    ...(googleId && googleSecret ? { google: { clientId: googleId, clientSecret: googleSecret, ...policy } } : {}),
    ...(slackId && slackSecret ? { slack: { clientId: slackId, clientSecret: slackSecret, ...policy } } : {}),
  };
}

export function enabledBetterAuthProviderIds(env: BetterAuthLaneEnv): string[] {
  return isBetterAuthConfigured(env) ? Object.keys(socialProviders(env)) : [];
}

export function bootstrapRequirements(env: BetterAuthLaneEnv): {
  requiresToken: boolean;
  requiresOwnerEmail: boolean;
} {
  return {
    requiresToken: configuredSecret(env.BETTER_AUTH_BOOTSTRAP_TOKEN) !== null,
    requiresOwnerEmail: configuredSecret(env.BETTER_AUTH_OWNER_EMAIL) !== null,
  };
}

function isLoopbackRequest(request: Request | undefined): boolean {
  if (!request) return false;
  try {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Public description of first-account rules. Does not include the token or the email. */
export function publicBootstrap(
  env: BetterAuthLaneEnv,
  request: Request,
): { requiresToken: boolean; requiresOwnerEmail: boolean; locked: boolean } {
  const requirements = bootstrapRequirements(env);
  return {
    ...requirements,
    locked: !isLoopbackRequest(request) && !requirements.requiresToken,
  };
}

function secretsEqual(expected: string, provided: string): boolean {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function assertOwnerBootstrap(
  env: BetterAuthLaneEnv,
  request: Request | undefined,
  email: string,
  APIError: typeof import("better-auth").APIError,
): void {
  const token = configuredSecret(env.BETTER_AUTH_BOOTSTRAP_TOKEN);
  const owner = configuredSecret(env.BETTER_AUTH_OWNER_EMAIL);
  if (owner && owner.toLowerCase() !== email.trim().toLowerCase()) {
    throw new APIError("FORBIDDEN", {
      message: "This email is not allowed to create the dashboard owner.",
    });
  }
  const loopback = isLoopbackRequest(request);
  if (!loopback || token) {
    if (!token) {
      throw new APIError("FORBIDDEN", {
        message: "Sign-up is locked until a setup token is configured.",
      });
    }
    const provided = request?.headers.get(BETTER_AUTH_BOOTSTRAP_HEADER) ?? "";
    if (!secretsEqual(token, provided)) {
      throw new APIError("FORBIDDEN", {
        message: "A setup token is required to create the first account.",
      });
    }
  }
}

/** Run admission before Better Auth's existing-email lookup, not only its create hook.
 * The hook remains authoritative against stale invitations and concurrent requests.
 */
async function signupAdmission(request: Request, env: BetterAuthLaneEnv, enrollment?: BetterAuthEnrollmentAdapter): Promise<Request | Response> {
  if (request.method !== "POST" || !/^\/api\/auth\/sign-up\/email\/?$/.test(new URL(request.url).pathname)) return request;
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.clone().json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body");
    body = value as Record<string, unknown>;
  } catch {
    return Response.json({ message: "Invalid sign-up request." }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128 || typeof body.name !== "string" || !body.name.trim()) {
    return Response.json({ message: "Invalid sign-up request." }, { status: 400 });
  }
  const denied = () => Response.json({ message: "Sign-up is closed or locked. A valid invitation or setup authorization is required." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const row = await env.AGENT_AUDIT!.prepare('SELECT COUNT(*) AS c FROM "user"').first<{ c: number }>();
  if (Number(row?.c ?? 0) === 0) {
    const token = configuredSecret(env.BETTER_AUTH_BOOTSTRAP_TOKEN);
    const owner = configuredSecret(env.BETTER_AUTH_OWNER_EMAIL);
    if ((owner && owner.toLowerCase() !== email) || ((!isLoopbackRequest(request) || token) && (!token || !secretsEqual(token, request.headers.get(BETTER_AUTH_BOOTSTRAP_HEADER) ?? "")))) return denied();
  } else {
    const token = request.headers.get(BETTER_AUTH_INVITATION_HEADER) ?? "";
    if (!enrollment?.enabled || !/^[a-f0-9]{64}$/i.test(token) || !await enrollment.validateInvitation({ token, email })) return denied();
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body: JSON.stringify({ ...body, email }) });
}

function withDeadline(work: Promise<Response>, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error("Auth handler deadline exceeded; check auth storage availability.");
      resolve(
        Response.json(
          {
            error:
              "Auth request timed out. Please try again.",
          },
          { status: 504 },
        ),
      );
    }, ms);
    work.then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function createBetterAuth(env: BetterAuthLaneEnv, enrollment?: BetterAuthEnrollmentAdapter) {
  const { APIError, betterAuth } = await import("better-auth");
  return betterAuth({
    appName: "shiba",
    // Upstream background-task logging can include raw transport exceptions.
    // The outer handler owns sanitized errors and explicit delivery outcomes.
    logger: { disabled: true },
    // The binding satisfies Better Auth's structural D1Database contract;
    // tests may substitute node:sqlite's DatabaseSync (also supported).
    database: env.AGENT_AUDIT as never,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: BETTER_AUTH_BASE_PATH,
    socialProviders: socialProviders(env),
    account: {
      accountLinking: {
        enabled: true,
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        trustedProviders: [],
        updateUserInfoOnLink: false,
      },
    },
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (source.method !== "oauth") return;
        // 1.7.7 can promote emailVerified on returning OAuth sign-in. Gate
        // before linking or updating, including already-linked identities.
        const deny = { error: "social_sign_in_not_allowed",
          errorDescription: "Sign in requires an existing, locally verified dashboard account." };
        if (source.action === "create-user" || !env.AGENT_AUDIT || !user.id || user.emailVerified !== true ||
          !enabledBetterAuthProviderIds(env).includes(source.oauth?.providerId ?? "")) return deny;
        const policy = await readBetterAuthAccountPolicy(env.AGENT_AUDIT, user.id);
        const local = await env.AGENT_AUDIT.prepare(`SELECT email,emailVerified FROM "user" WHERE id=?`)
          .bind(user.id).first<{ email: string; emailVerified: number }>();
        const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
        if (!policy || !local || local.emailVerified !== 1 || policy.email !== email ||
          local.email.trim().toLowerCase() !== email) return deny;
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    emailVerification: {
      sendOnSignUp: enrollment?.enabled === true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      beforeEmailVerification: async (user) => {
        const policy = await readBetterAuthAccountPolicy(env.AGENT_AUDIT!, user.id);
        if (policy?.kind !== "invited" || !enrollment?.enabled ||
          !policy.invitationId || !policy.workspaceId ||
          !await enrollment.isEnrollmentCurrent({ invitationId: policy.invitationId,
            workspaceId: policy.workspaceId, email: policy.email })) {
          throw new APIError("FORBIDDEN", { message: "This invitation is unavailable. Ask for a new invitation." });
        }
      },
      sendVerificationEmail: async ({ user, url }, request) => {
        try {
          const policy = await readBetterAuthAccountPolicy(env.AGENT_AUDIT!, user.id);
          // Bootstrap remains compatible and never sends an unsolicited verification.
          if (policy?.kind === "bootstrap") return;
          if (!policy || !enrollment?.enabled || !policy.invitationId || !policy.workspaceId ||
            !await enrollment.isEnrollmentCurrent({ invitationId: policy.invitationId,
              workspaceId: policy.workspaceId, email: policy.email })) throw new Error("Verification unavailable.");
          await enrollment.sendVerificationEmail({ email: policy.email, url, request });
        } catch {
          // BetterAuth 1.7.7 swallows send callback exceptions. Record the
          // request outcome explicitly so the handler cannot report delivery.
          const operation = deliveryOperations.get(request?.headers.get(AUTH_OPERATION_HEADER) ?? "");
          if (operation) operation.failed = true;
        }
      },
    },
    session: {
      // The dashboard calls getSession on every request; a short-lived
      // signed cookie cache keeps routine reads off D1.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    trustedOrigins: (request?: Request) => {
      const origins = new Set(DEV_ORIGINS);
      if (request) origins.add(new URL(request.url).origin);
      if (env.BETTER_AUTH_URL) {
        try {
          origins.add(new URL(env.BETTER_AUTH_URL).origin);
        } catch {
          // malformed BETTER_AUTH_URL — dev origins + request origin still apply
        }
      }
      return [...origins];
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const row = await env.AGENT_AUDIT?.prepare(
              `SELECT COUNT(*) AS c FROM "user"`,
            ).first<{ c: number }>();
            const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
            const accountId = crypto.randomUUID();
            if ((row?.c ?? 0) === 0) {
              assertOwnerBootstrap(env, context?.request, email, APIError);
              await recordBetterAuthAccountPolicy(env.AGENT_AUDIT!, { accountId, email,
                kind: "bootstrap", invitationId: null, workspaceId: null });
            } else {
              const token = context?.request?.headers.get(BETTER_AUTH_INVITATION_HEADER) ?? "";
              if (!enrollment?.enabled || !/^[a-f0-9]{64}$/.test(token)) {
                throw new APIError("FORBIDDEN", { message: "Sign-up is closed. A configured, verified-email invitation is required." });
              }
              const invitation = await enrollment.validateInvitation({ token, email });
              if (!invitation) throw new APIError("FORBIDDEN", { message: "This invitation is unavailable." });
              await recordBetterAuthAccountPolicy(env.AGENT_AUDIT!, { accountId, email,
                kind: "invited", invitationId: invitation.invitationId, workspaceId: invitation.workspaceId });
            }
            // Neither the request nor an invitation can assert email ownership.
            return { data: { ...user, id: accountId, emailVerified: false } };
          },
        },
      },
    },
    telemetry: { enabled: false },
  });
}

/** One instance per isolate/env — construction validates config once. */
export function betterAuthFor(env: BetterAuthLaneEnv, enrollment?: BetterAuthEnrollmentAdapter): BetterAuthInstance {
  let byEnrollment = instances.get(env);
  if (!byEnrollment) { byEnrollment = new Map(); instances.set(env, byEnrollment); }
  let instance = byEnrollment.get(enrollment);
  if (!instance) {
    const cache = byEnrollment;
    instance = createBetterAuth(env, enrollment);
    cache.set(enrollment, instance);
    // A failed construction is not cached, as before the lazy import.
    instance.catch(() => cache.delete(enrollment));
  }
  return instance;
}

const identityRedact: SecretRedactor = (message) => message;

/**
 * `/api/auth/*` route surface (sign-in, sign-up, session verbs, sign-out).
 * Returns null when the lane is dark so the worker falls through to the API
 * 404; 503 when the lane is on but its D1 store is missing — that is a
 * deploy misconfiguration, not "unauthenticated".
 */
export async function handleBetterAuth(
  request: Request,
  env: BetterAuthLaneEnv,
  redact: SecretRedactor = identityRedact,
  enrollment?: BetterAuthEnrollmentAdapter,
  bootstrapVerification?: BootstrapVerificationAdapter,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isBetterAuthPath(url.pathname) || !isBetterAuthConfigured(env)) {
    return null;
  }
  if (url.pathname === `${BETTER_AUTH_BASE_PATH}/bootstrap` && request.method === "GET") {
    return Response.json(publicBootstrap(env, request), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === `${BETTER_AUTH_BASE_PATH}/social-providers` && request.method === "GET") {
    const enabled = enabledBetterAuthProviderIds(env);
    return Response.json({ providers: { google: enabled.includes("google"), slack: enabled.includes("slack") } }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === `${BETTER_AUTH_BASE_PATH}/invitation-policy` && request.method === "GET") {
    return Response.json({ enabled: enrollment?.enabled === true,
      ...(enrollment?.enabled ? {} : { reason: "Invitation enrollment is currently unavailable. Contact your workspace owner." }) },
    { headers: { "Cache-Control": "no-store" } });
  }
  const callbackProvider = url.pathname.match(/^\/api\/auth\/callback\/([^/]+)\/?$/)?.[1];
  if (callbackProvider && !enabledBetterAuthProviderIds(env).includes(callbackProvider as "google" | "slack")) {
    return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (env.AGENT_AUDIT === undefined) {
    return Response.json(
      { error: "Auth storage is not configured." },
      { status: 503 },
    );
  }
  const operationId = crypto.randomUUID(), delivery = { failed: false };
  deliveryOperations.set(operationId, delivery);
  try {
    return await withDeadline(
      (async () => {
        await ensureBetterAuthSchema(env as { AGENT_AUDIT: D1Database });
        const admitted = await signupAdmission(request, env, enrollment);
        if (admitted instanceof Response) return admitted;
        request = admitted;
        const bootstrapResponse = await handleBootstrapVerification(request, env as { AGENT_AUDIT: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL?: string }, bootstrapVerification,
          async () => {
            const account = await resolveBetterAuthSessionAccount(request, env, redact);
            return account?.policy.kind === "bootstrap" && account.sessionId && account.sessionExpiresAt
              ? { accountId: account.policy.accountId, email: account.policy.email, sessionId: account.sessionId, sessionExpiresAt: account.sessionExpiresAt, emailVerified: account.emailVerified } : null;
          });
        if (bootstrapResponse) return bootstrapResponse;
        if (url.pathname === `${BETTER_AUTH_BASE_PATH}/enrollment-status` && request.method === "GET") {
          const account = await resolveBetterAuthSessionAccount(request, env, redact);
          return Response.json(account ? { restricted: account.policy.kind === "invited", emailVerified: account.emailVerified,
            authenticated: account.policy.kind === "bootstrap" || account.emailVerified } : { error: "A current session is required." },
          { status: account ? 200 : 401, headers: { "Cache-Control": "no-store" } });
        }
        const headers = new Headers(request.headers);
        // Always overwrite caller input. The marker is request-local and is
        // never included in a response, email, persisted row or log.
        headers.set(AUTH_OPERATION_HEADER, operationId);
        const response = await (await betterAuthFor(env, enrollment)).handler(new Request(request, { headers }));
        return delivery.failed ? Response.json({ error: "Verification delivery failed. Sign in and resend verification, or ask your workspace owner to check email setup." },
          { status: 503, headers: { "Cache-Control": "no-store" } }) : response;
      })(),
      AUTH_HANDLER_DEADLINE_MS,
    );
  } catch (error) {
    console.error(
      redact(error instanceof Error ? error.message : String(error)),
    );
    return Response.json({ error: "Auth request failed." }, { status: 500 });
  } finally {
    deliveryOperations.delete(operationId);
  }
}

/**
 * Verified dashboard identity for the built-in lane: the freshly verified
 * account email, or the exact legacy bootstrap account's email. Any failure
 * (missing tables, bad/revoked cookie, unknown provenance, D1 outage)
 * resolves to null — the caller fails closed.
 */
export async function resolveBetterAuthUserId(
  request: Request,
  env: BetterAuthLaneEnv,
  redact: SecretRedactor = identityRedact,
): Promise<string | null> {
  const account = await resolveBetterAuthSessionAccount(request, env, redact);
  return account && (account.policy.kind === "bootstrap" || account.emailVerified) ? account.policy.email : null;
}

/** Always re-read provenance, verification and session revocation from D1, even with cookie-cache hits. */
export async function resolveBetterAuthSessionAccount(
  request: Request,
  env: BetterAuthLaneEnv,
  redact: SecretRedactor = identityRedact,
): Promise<{ policy: BetterAuthAccountPolicy; emailVerified: boolean; sessionId?: string; sessionExpiresAt?: number } | null> {
  if (!isBetterAuthConfigured(env) || env.AGENT_AUDIT === undefined) {
    return null;
  }
  try {
    await ensureBetterAuthSchema(env as { AGENT_AUDIT: D1Database });
    const session = await (await betterAuthFor(env)).api.getSession({
      headers: request.headers,
    });
    if (!session?.user?.id || !session.session.id) return null;
    const policy = await readBetterAuthAccountPolicy(env.AGENT_AUDIT, session.user.id);
    if (!policy) return null;
    const row = await env.AGENT_AUDIT.prepare(`SELECT u.email,u.emailVerified,s.expiresAt
      FROM "user" u JOIN "session" s ON s.userId=u.id WHERE u.id=? AND s.id=?`)
      .bind(session.user.id, session.session.id).first<{ email: string; emailVerified: number; expiresAt: string | number }>();
    if (!row || row.email.trim().toLowerCase() !== policy.email ||
      row.email.trim().toLowerCase() !== session.user.email.trim().toLowerCase()) return null;
    const expiresAt = typeof row.expiresAt === "number" ? row.expiresAt : Date.parse(row.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { policy, emailVerified: row.emailVerified === 1, sessionId: session.session.id, sessionExpiresAt: expiresAt };
  } catch (error) {
    console.warn(
      `better-auth session check failed: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}
