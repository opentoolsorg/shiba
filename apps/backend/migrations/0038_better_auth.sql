-- Better Auth core tables (moved off the cold-start DDL path — WS01).
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "account" (
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
);
CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
CREATE TABLE IF NOT EXISTS shiba_auth_bootstrap_verifications (
  user_id TEXT NOT NULL PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shiba_auth_account_policy (
  account_id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('bootstrap','invited')),
  invitation_id TEXT,
  workspace_id TEXT,
  CHECK((kind='bootstrap' AND invitation_id IS NULL AND workspace_id IS NULL)
    OR (kind='invited' AND invitation_id IS NOT NULL AND workspace_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS shiba_auth_one_bootstrap
  ON shiba_auth_account_policy(kind) WHERE kind='bootstrap';
CREATE TABLE IF NOT EXISTS shiba_auth_policy_migrations (
  migration_id TEXT NOT NULL PRIMARY KEY
);