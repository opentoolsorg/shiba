import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPersonalAuthMaterial, stagePersonalAuth } from "./link-operator-auth.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BYTES = 65_536;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const denied = () => new Error("The selected personal CLI account is unavailable. Inspect its native login and select it again.");

/** No daemon bearer, Git credential, API key, proxy, or alternate provider enters a personal child. */
export function personalChildEnvironment(homeDir, source = process.env, harness) {
  const keys = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "SystemRoot", "COMSPEC", "PATHEXT"];
  const env = Object.fromEntries(keys.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
  Object.assign(env, { HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, ".config"), XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" });
  if (harness === "claude-code") env.CLAUDE_CONFIG_DIR = path.join(homeDir, ".claude");
  if (harness === "codex") env.CODEX_HOME = path.join(homeDir, ".codex");
  return env;
}

/** Bounded non-inference subprocess. Output is parsed locally and never logged. */
export function runPersonalAuthCommand(command, args, options = {}) {
  if (options.signal?.aborted) return Promise.reject(denied());
  return new Promise((resolve, reject) => {
    let child, timer, killTimer, finishTimer, bytes = 0, stdout = "", settled = false, result, failure, terminationUnconfirmed = false;
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finishTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) { const error = denied(); if (terminationUnconfirmed) error.terminationUnconfirmed = true; reject(error); } else resolve({ stdout, result });
    };
    const signal = (kind) => {
      if (!child?.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, kind); else child.kill(kind); } catch {}
    };
    const stop = (failed = false) => {
      failure ||= failed;
      signal("SIGTERM");
      killTimer ??= setTimeout(() => signal("SIGKILL"), 250);
      finishTimer ??= setTimeout(() => { failure = true; terminationUnconfirmed = true; finish(); }, 1500);
    };
    const onAbort = () => stop(true);
    try { child = spawn(command, args, { cwd: options.homeDir, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }); }
    catch { failure = true; return finish(); }
    child.on("error", () => { failure = true; finish(); });
    child.stdin.on("error", () => stop(true));
    child.on("close", (code) => {
      if (!options.rpc && code !== 0) failure = true;
      if (options.rpc && result === undefined) failure = true;
      finish();
    });
    const send = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { stop(true); } };
    let buffer = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk); if (bytes > MAX_BYTES) return stop(true);
      stdout += chunk;
      if (!options.rpc) return;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return stop(true); }
        if (message?.method && Object.hasOwn(message, "id")) return stop(true);
        if (message?.id === 1) {
          if (message.error || !message.result) return stop(true);
          send({ method: "initialized", params: {} }); send({ id: 2, method: "account/read", params: { refreshToken: false } });
        } else if (message?.id === 2) {
          if (message.error || !message.result) return stop(true);
          result = message.result; stop();
        }
      }
    });
    child.stderr.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > MAX_BYTES) stop(true); });
    timer = setTimeout(() => stop(true), options.timeoutMs ?? 8000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    if (options.rpc) send({ id: 1, method: "initialize", params: { clientInfo: { name: "shiba-personal-auth", version: "1" } } });
    else child.stdin.end();
  });
}

function versionFrom(harness, text) {
  const match = text.trim().match(harness === "claude-code" ? /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/ : /^codex(?:-cli)? (\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw denied();
  const [major, minor, patch] = match.slice(1).map(Number);
  if (harness === "claude-code" ? major !== 2 || minor !== 1 || patch < 268 : major !== 0 || minor < 157 || (minor === 157 && patch < 1)) throw denied();
  return `${major}.${minor}.${patch}`;
}

/** Parse only supported native billing identities, not arbitrary CLI text or exit codes. */
export function personalAccountIdentity(harness, body, material, homeDir) {
  if (harness === "claude-code") {
    if (body?.loggedIn !== true || body.authMethod !== "claude.ai" || body.apiProvider !== "firstParty" ||
        body.configDirectory !== path.join(homeDir, ".claude") || !ACCOUNT.test(body.email ?? "") ||
        typeof body.orgId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(body.orgId)) throw denied();
    return ["claude.ai", body.email.toLowerCase(), body.orgId];
  }
  const account = body?.account;
  if (body?.requiresOpenaiAuth !== true || account?.type !== "chatgpt" || !ACCOUNT.test(account.email ?? "") ||
      !["plus", "pro", "team", "business", "enterprise", "edu"].includes(account.planType) || typeof material.accountId !== "string") throw denied();
  return ["chatgpt", account.email.toLowerCase(), material.accountId, account.planType];
}

export async function inspectStagedPersonalAccount({ harness, homeDir, material, sourceEnv = process.env, run = runPersonalAuthCommand, now = Date.now(), signal }) {
  if (!["claude-code", "codex"].includes(harness) || material.expiresAt <= now + 120_000) throw denied();
  // The file-backed Claude path is verified here only on Linux. Keychain-only
  // and native Windows account routing need their own explicit proof adapter.
  if (process.platform === "win32" || (harness === "claude-code" && process.platform !== "linux")) throw denied();
  const command = harness === "claude-code" ? "claude" : "codex";
  const env = personalChildEnvironment(homeDir, sourceEnv, harness);
  signal?.throwIfAborted();
  const cliVersion = versionFrom(harness, (await run(command, ["--version"], { env, homeDir, signal })).stdout);
  const probe = await run(command, harness === "claude-code" ? ["--safe-mode", "--setting-sources", "user", "auth", "status"] : ["app-server", "--listen", "stdio://", "-c", 'model_provider="openai"', "-c", 'cli_auth_credentials_store="file"', "-c", "features.apps=false", "-c", "features.hooks=false", "-c", "features.multi_agent=false", "-c", "features.goals=false", "-c", "features.plugins=false", "-c", "mcp_servers={}"], { env, homeDir, signal, rpc: harness === "codex" });
  let body;
  try { body = harness === "codex" ? probe.result : JSON.parse(probe.stdout); } catch { throw denied(); }
  const identity = personalAccountIdentity(harness, body, material, homeDir);
  const after = await readPersonalAuthMaterial(homeDir, harness, now);
  if (after.credentialDigest !== material.credentialDigest) throw denied();
  signal?.throwIfAborted();
  const accountFingerprint = digest(["shiba-personal-account-v1", harness, "native-subscription", identity]);
  return { schemaVersion: 1, harness, billingMode: "native-subscription", accountFingerprint,
    authVersion: digest(["shiba-personal-auth-v1", harness, cliVersion, accountFingerprint, material.credentialDigest]), cliVersion,
    probeMethod: harness === "claude-code" ? "claude-auth-status" : "codex-account-read", probedAt: now };
}

export async function probePersonalAccount({ harness, userHome = process.env.HOME, sourceEnv = process.env, run, now = Date.now(), signal }) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-personal-auth-"));
  try {
    const material = await stagePersonalAuth(homeDir, userHome, harness, now);
    return await inspectStagedPersonalAccount({ harness, homeDir, material, sourceEnv, run, now, signal });
  } catch (error) { const unavailable = denied(); if (error?.terminationUnconfirmed) unavailable.terminationUnconfirmed = true; throw unavailable; }
  finally { await fs.rm(homeDir, { recursive: true, force: true }); }
}

export function validatePersonalSelection(value) {
  if (!value || !["claude-code", "codex"].includes(value.harness) || value.billingMode !== "native-subscription" || !HASH.test(value.accountFingerprint)) throw denied();
  return { harness: value.harness, billingMode: value.billingMode, accountFingerprint: value.accountFingerprint };
}
