import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Credential files Claude Code and Codex read from the operator home.
 * Session history and the rest of those directories stay put.
 */
const AUTH_FILES = [
  [".codex", "auth.json"],
  [".claude", ".credentials.json"],
];

/**
 * Copy subscription auth into a disposable run HOME. The copy is a regular
 * file mode 0400, never a symlink, so a task cannot write the operator's
 * real credentials. A name the run already has is left alone. Missing
 * logins are ignored. Nothing is copied when the run HOME is the operator HOME.
 * @param {string} homeDir
 * @param {string | undefined} userHome
 * @returns {Promise<string[]>}
 */
export async function copyOperatorAuth(homeDir, userHome) {
  if (!userHome) return [];
  if (path.resolve(userHome) === path.resolve(homeDir)) return [];
  const copied = [];
  for (const [dir, file] of AUTH_FILES) {
    const relative = path.join(dir, file);
    const source = path.join(userHome, relative);
    const destDir = path.join(homeDir, dir);
    const dest = path.join(destDir, file);
    try {
      await fs.lstat(dest);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") continue;
    }
    let data;
    try {
      // stat follows a link so the bytes are copied. The destination is never a link.
      const stat = await fs.stat(source);
      if (!stat.isFile()) continue;
      data = await fs.readFile(source);
    } catch {
      continue;
    }
    await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(dest, data, { flag: "wx", mode: 0o400 });
    await fs.chmod(dest, 0o400);
    copied.push(relative);
  }
  return copied;
}

const PERSONAL_AUTH_PATHS = {
  "claude-code": [".claude", ".credentials.json"],
  codex: [".codex", "auth.json"],
};

/** Read only a selected, regular credential file without following links. */
async function selectedFile(userHome, harness) {
  const parts = PERSONAL_AUTH_PATHS[harness];
  if (!parts || !path.isAbsolute(userHome)) throw new Error("Personal account file authentication is unavailable.");
  const home = await fs.realpath(userHome);
  const directory = path.join(home, parts[0]);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Personal account file authentication is unavailable.");
  const file = await fs.open(path.join(directory, parts[1]), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 256_000) throw new Error("Personal account file authentication is unavailable.");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Personal account authentication changed during inspection.");
    }
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Personal account file authentication is unavailable."); }
    return { bytes, value, parts };
  } finally { await file.close(); }
}

const nonsecret = (value) => typeof value === "string" && value.length > 0 && value.length <= 320 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/**
 * Stage one explicitly selected file-backed native login in a new local HOME.
 * No provider key, helper, MCP configuration or other provider login is copied.
 * This prevents ambient auth fallback; it is not an operating-system sandbox.
 */
function materialFrom(bytes, value, harness, now) {
  let expiresAt, accountId = null;
  const only = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));
  if (harness === "claude-code") {
    const oauth = value?.claudeAiOauth;
    if (!only(value, ["claudeAiOauth"]) || !only(oauth, ["accessToken", "refreshToken", "expiresAt", "scopes", "subscriptionType", "rateLimitTier"]) || !["pro", "max", "team", "enterprise"].includes(oauth.subscriptionType) ||
        typeof oauth.accessToken !== "string" || oauth.accessToken.length < 8 || !Number.isSafeInteger(oauth.expiresAt)) throw new Error("Selected Claude file login is unavailable.");
    expiresAt = oauth.expiresAt;
  } else {
    const tokens = value?.tokens;
    if (!only(value, ["auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh"]) || !only(tokens, ["access_token", "refresh_token", "id_token", "account_id"])) throw new Error("Selected Codex credential format contains unreviewed authentication material.");
    if (value?.auth_mode && value.auth_mode !== "chatgpt") throw new Error("Selected Codex login is not a ChatGPT account.");
    if (value?.OPENAI_API_KEY || !tokens || typeof tokens.access_token !== "string" || !nonsecret(tokens.account_id)) throw new Error("Selected Codex file login is unavailable.");
    let claims;
    try { claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString("utf8")); }
    catch { throw new Error("Selected Codex token expiry cannot be inspected."); }
    if (!Number.isSafeInteger(claims?.exp)) throw new Error("Selected Codex token expiry cannot be inspected.");
    expiresAt = claims.exp * 1000; accountId = tokens.account_id;
  }
  if (expiresAt <= now + 120_000 || expiresAt > now + 90 * 24 * 60 * 60_000) throw new Error("Selected personal login is expired or cannot be verified.");
  return { credentialDigest: createHash("sha256").update(bytes).digest("hex"), expiresAt, accountId };
}

export async function readPersonalAuthMaterial(homeDir, harness, now = Date.now()) {
  const { bytes, value } = await selectedFile(homeDir, harness);
  return materialFrom(bytes, value, harness, now);
}

export async function stagePersonalAuth(homeDir, userHome, harness, now = Date.now()) {
  if (!userHome || path.resolve(homeDir) === path.resolve(userHome)) throw new Error("A separate personal run home is required.");
  const { bytes, value, parts } = await selectedFile(userHome, harness);
  const material = materialFrom(bytes, value, harness, now);
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
  const destination = path.join(homeDir, parts[0]);
  await fs.mkdir(destination, { mode: 0o700 });
  await fs.writeFile(path.join(destination, parts[1]), bytes, { mode: 0o400, flag: "wx" });
  if (harness === "codex") {
    await fs.writeFile(path.join(destination, "config.toml"), 'cli_auth_credentials_store = "file"\nmodel_provider = "openai"\n', { mode: 0o400, flag: "wx" });
  } else {
    // Claude's account labels are cached separately from its credentials.
    // Retain only identity metadata; settings, hooks, helpers and MCPs stay out.
    let source;
    let metadata;
    try {
      metadata = await fs.open(path.join(userHome, ".claude.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await metadata.stat();
      if (!stat.isFile() || stat.size > 256_000) throw new Error("Unsupported account metadata.");
      source = JSON.parse(await metadata.readFile("utf8"));
    } catch { source = {}; }
    finally { await metadata?.close(); }
    const account = source?.oauthAccount;
    if (account && nonsecret(account.emailAddress) && nonsecret(account.organizationUuid)) {
      const oauthAccount = Object.fromEntries(["emailAddress", "organizationUuid", "accountUuid", "organizationName", "displayName"]
        .filter((key) => nonsecret(account[key])).map((key) => [key, account[key]]));
      await fs.writeFile(path.join(homeDir, ".claude.json"), JSON.stringify({ oauthAccount }), { mode: 0o400, flag: "wx" });
    }
  }
  return material;
}

/** Secret-screen complete approval text locally, before any event or upload. */
export async function isSafePersonalApprovalReview(review, userHome, harness, sourceEnv = process.env) {
  if (typeof review !== "string" || review.length > 2000 || !review) return false;
  let action;
  try { action = JSON.parse(review); } catch { return false; }
  if (action?.version !== 1 || action.provider !== (harness === "codex" ? "codex" : "claude")) return false;
  if (harness === "codex" ? !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"].includes(action.method)
    : action.method !== "can_use_tool" || !["Bash", "Edit", "Read", "Write", "Grep", "Glob", "NotebookEdit"].includes(action.payload?.request?.tool_name)) return false;
  const displayed = [review];
  const decode = item => { if (typeof item === "string") displayed.push(item); else if (item && typeof item === "object") for (const value of Object.values(item)) decode(value); };
  decode(action);
  if (displayed.some(text => /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{12,}\.|https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(text) || /"(?:password|access_token|refresh_token|id_token|api_key|authorization|client_secret)"\s*:/i.test(text))) return false;
  const { value } = await selectedFile(userHome, harness);
  const secrets = [];
  const collect = (object) => {
    if (!object || typeof object !== "object") return;
    for (const [key, item] of Object.entries(object)) {
      if (typeof item === "string" && item.length >= 8 && /token|secret|key|account_id/i.test(key)) secrets.push(item);
      else if (item && typeof item === "object") collect(item);
    }
  };
  collect(value);
  for (const [key, item] of Object.entries(sourceEnv)) if (/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/.test(key) && typeof item === "string" && item.length >= 8) secrets.push(item);
  return !secrets.some(secret => displayed.some(text => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))));
}
