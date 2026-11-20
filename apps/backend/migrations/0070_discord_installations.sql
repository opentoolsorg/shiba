-- Discord bot installations: one row per Discord server (guild) the bot was
-- installed into through OAuth2. No Discord token is stored here; the bot
-- token stays a Worker secret and the installer's user token is revoked
-- right after the exchange.
CREATE TABLE IF NOT EXISTS discord_installations (
  guild_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  guild_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'disconnected', 'error')),
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  commands_registered INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS discord_installations_org ON discord_installations(org_id);
CREATE TABLE IF NOT EXISTS discord_install_states (
  state_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expected_guild_id TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
