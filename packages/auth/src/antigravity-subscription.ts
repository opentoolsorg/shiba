/**
 * T50 — antigravity-subscription provider on the T47 core
 * (PLAN.md §18.12). The one flow that uses the `waiting` phase:
 *
 *   begin()     → spawn the pinned `agy` ACP binary in a dedicated auth
 *                 sandbox with the isolated profile env; it prints the
 *                 Google sign-in URL on stdout and listens on a
 *                 container-loopback port. Flow records
 *                 pending{redirectUri,state,sandboxId} and `waiting`.
 *   callback    → POST /api/antigravity/callback validates the operator's
 *                 pasted redirect URL against that pending record
 *                 (ruleset ported verbatim from t3code) and delivers it
 *                 into the container listener. Delivery ≠ authentication.
 *   verify()    → the capability probe — the ACP process exchanged the
 *                 code only if the profile's acp_token.json materialized.
 *
 * No credential ever lives in the Worker: tokens are written by the ACP
 * process into the container profile (AGY_ACP_FORCE_FILE_STORAGE=1), so
 * there is no Worker secret for this provider at all.
 */
import { getSandbox } from "./sandbox.js";
import {
  type AntigravityPendingCallback,
  type ProviderAuthController,
  antigravityBrowserCommand,
  antigravityEnvironment,
  antigravityProfilePaths,
  antigravityProfileSettings,
  antigravitySubscriptionProfileDir,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
  ANTIGRAVITY_AUTH_HOSTS,
  ANTIGRAVITY_BROWSER_HELPER_PATH,
  ANTIGRAVITY_BROWSER_HELPER_SOURCE,
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
} from "@shiba/shared";
import { shellJoin } from "@shiba/shared";
import { createAuthController, type AuthProviderHooks } from "./controller.js";

/** Minimal sandbox surface the flow needs — injected for tests. */
export interface AntigravityAuthSandbox {
  exec(command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, content: string): Promise<void>;
  /** Keep the container awake — the DO's default sleepAfter (1m) is shorter than a human OAuth round-trip. */
  setSleepAfter?(sleepAfter: string | number): Promise<void>;
  /** Egress allowlist — the default sandbox gates deny the Google OAuth/API hosts the exchange needs. */
  setAllowedHosts?(hosts: string[]): Promise<void>;
  destroy?(): Promise<void>;
}

export interface AntigravityAuthDeps {
  sandboxFor(sandboxId: string): AntigravityAuthSandbox;
  /** Log-poll attempts before the auth URL is declared missing. Default 30. */
  pollAttempts?: number;
  /** Ms between polls. Default 1_000. */
  pollIntervalMs?: number;
}

/** Env the provider reads — the token KV and the sandbox binding. */
export interface AntigravityAuthEnv {
  AGENT_TOKENS: KVNamespace;
  // The DO binding's generic is Env-shaped; the provider only hands it to
  // getSandbox, so `unknown` keeps every Env assignable. Optional on the
  // type so the registry can refuse the harness before it is needed.
  Sandbox?: unknown;
}

const AUTH_SANDBOX_PREFIX = "agy-auth-";
const AUTH_LOG_PATH = "/tmp/agy-auth.log";
const AUTH_HANDSHAKE_PATH = "/tmp/agy-handshake.ndjson";

/**
 * The ACP handshake the server answers with the Google sign-in URL:
 * `initialize` then `authenticate` with the personal OAuth method — the
 * same eager-authenticate sequence a real ACP client (Zed, t3code) drives.
 * Without it the process prints nothing and the flow would time out.
 */
const AUTH_HANDSHAKE = [
  JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "shiba-ai-coworker", version: "0.1.0" },
    },
  }),
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "authenticate",
    params: { methodId: "oauth-personal" },
  }),
];

function sandboxIdFor(instanceId: string): string {
  return `${AUTH_SANDBOX_PREFIX}${instanceId.slice("agy-sub:".length)}`;
}

/**
 * Spawn `agy` detached inside the auth sandbox, env = the profile launch
 * env (ambient Google keys stripped by antigravityEnvironment), stdout
 * teed to AUTH_LOG_PATH for polling.
 */
async function spawnAuthProcess(
  sandbox: AntigravityAuthSandbox,
  profileDir: string,
): Promise<void> {
  // The OAuth round-trip is human-paced (account chooser, consent, paste).
  // The class sleepAfter (1m) would stop the container — and with it the
  // ACP listener and its PKCE verifier — while the operator is still on
  // the Google page. 30m bounds the window; the flow must land inside it.
  await sandbox.setSleepAfter?.("30m");
  const paths = antigravityProfilePaths(profileDir);
  const mkdir = await sandbox.exec(
    shellJoin(["mkdir", "-p", paths.acpDirectory, paths.tempDirectory]),
  );
  if (mkdir.exitCode !== 0) {
    throw new Error(`profile setup failed: ${mkdir.stderr.trim() || `exit ${mkdir.exitCode}`}`);
  }
  const chmod = await sandbox.exec(shellJoin(["chmod", "700", paths.geminiHome, paths.acpDirectory]));
  if (chmod.exitCode !== 0) {
    throw new Error(`profile setup failed: ${chmod.stderr.trim() || `exit ${chmod.exitCode}`}`);
  }
  // The token exchange leaves the container through the HTTPS
  // interceptor; without the Google OAuth/backend hosts it is refused
  // (520) and agy ends the flow with "credentials are unusable".
  await sandbox.setAllowedHosts?.([...ANTIGRAVITY_AUTH_HOSTS]);
  await sandbox.writeFile(paths.settingsPath, antigravityProfileSettings());
  // File-based BROWSER helper — agy's command tokenization corrupts an
  // inline node -e string (observed SyntaxError in the auth log).
  await sandbox.writeFile(ANTIGRAVITY_BROWSER_HELPER_PATH, ANTIGRAVITY_BROWSER_HELPER_SOURCE);
  const env = antigravityEnvironment(paths, {}, antigravityBrowserCommand());
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  // stdin carries the NDJSON handshake, then a sleep keeps the pipe open —
  // stdin EOF would end the ACP server (and its loopback listener) before
  // the operator's redirect can be delivered.
  await sandbox.writeFile(AUTH_HANDSHAKE_PATH, AUTH_HANDSHAKE.join("\n") + "\n");
  // Detached: the process keeps listening on its loopback port after exec
  // returns; stderr (merged into the log) carries the sign-in URL once the
  // authenticate call lands.
  const spawn = await sandbox.exec(
    `{ cat ${AUTH_HANDSHAKE_PATH}; sleep 86400; } | ${assignments} nohup agy --uid= > ${AUTH_LOG_PATH} 2>&1 & echo started`,
  );
  if (spawn.exitCode !== 0 || !spawn.stdout.includes("started")) {
    throw new Error("the Antigravity sign-in process failed to start.");
  }
}

/** Poll the process log until the ACP prints its sign-in URL line. */
async function readAuthorizationUrl(
  sandbox: AntigravityAuthSandbox,
  deps: Pick<AntigravityAuthDeps, "pollAttempts" | "pollIntervalMs">,
): Promise<string> {
  const attempts = deps.pollAttempts ?? 30;
  const interval = deps.pollIntervalMs ?? 1_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const log = await sandbox.exec(shellJoin(["cat", AUTH_LOG_PATH])).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    }));
    // The URL arrives either as the server's native prefix line or through
    // the BROWSER helper marker (JSON-encoded URL) — stderr is merged into
    // the same log, so one scan sees both.
    const line = log.stdout
      .split("\n")
      .find(
        (entry) =>
          entry.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX) ||
          entry.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER),
      );
    if (line !== undefined) {
      if (line.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)) {
        const decoded: unknown = JSON.parse(line.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length));
        if (typeof decoded !== "string") {
          throw new Error("the Antigravity sign-in URL was not readable.");
        }
        return decoded;
      }
      return line.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length).trim();
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  throw new Error("the Antigravity sign-in process did not offer a sign-in URL.");
}

/**
 * Deliver the validated callback into the container listener via scoped
 * exec curl — the faithful loopback send: --noproxy (no proxies), no
 * redirect following (curl default), -o /dev/null (no response logging),
 * --max-time 10 (10 s timeout), 2xx required.
 */
async function forwardIntoContainer(
  sandbox: AntigravityAuthSandbox,
  callback: URL,
): Promise<void> {
  const url = `http://127.0.0.1:${callback.port}${callback.pathname}${callback.search}`;
  const result = await sandbox.exec(
    shellJoin([
      "curl", "--globoff", "--noproxy", "*", "--max-time", "10", "-s", "-o", "/dev/null",
      "-w", "%{http_code}", "--request", "GET", url,
    ]),
  );
  const status = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !(status >= 200 && status < 300)) {
    throw new Error("Could not deliver the sign-in response. Start sign-in again.");
  }
}

/**
 * Build the T47 controller for `agy-sub:<account>`. `deps` is the test
 * seam — production callers omit it and the sandbox comes from the
 * worker env binding.
 */
export function antigravitySubscriptionAuth(
  env: AntigravityAuthEnv,
  instanceId: string,
  deps?: AntigravityAuthDeps,
): ProviderAuthController {
  const sandboxFor =
    deps?.sandboxFor ??
    ((sandboxId: string) =>
      getSandbox(env.Sandbox as never, sandboxId) as unknown as AntigravityAuthSandbox);
  const account = instanceId.slice("agy-sub:".length);
  const profileDir = antigravitySubscriptionProfileDir({ authAccount: account });
  const hooks: AuthProviderHooks<AntigravityAuthEnv> = {
    async probe(_probeEnv, probeInstanceId) {
      const sandbox = sandboxFor(sandboxIdFor(probeInstanceId));
      const check = await sandbox.exec(
        shellJoin(["test", "-s", antigravityProfilePaths(profileDir).tokenPath]),
      );
      // Delivered callback is not proof — the ACP process writes the token
      // file only after a real exchange with Google.
      return check.exitCode === 0
        ? { ok: true, message: "Antigravity sign-in token is stored in the container profile." }
        : { ok: false, message: "the sign-in token is not in the container profile yet." };
    },
    async onBegin(_beginEnv, beginInstanceId) {
      const sandboxId = sandboxIdFor(beginInstanceId);
      const sandbox = sandboxFor(sandboxId);
      await spawnAuthProcess(sandbox, profileDir);
      const url = await readAuthorizationUrl(sandbox, deps ?? {});
      const { authorizationUrl, redirectUri, state } = parseAntigravityAuthorizationUrl(url);
      const pending: AntigravityPendingCallback = { redirectUri, state, sandboxId };
      return {
        wait: "Open the sign-in URL, complete Google sign-in, then paste the failed http://127.0.0.1 redirect URL back here.",
        authorizationUrl,
        pending,
      };
    },
    async deliverCallback(_env, _instanceId, pending, callbackUrl) {
      const record = pending as AntigravityPendingCallback;
      const callback = validateAntigravityCallbackUrl(record, callbackUrl);
      await forwardIntoContainer(sandboxFor(record.sandboxId), callback);
      return { message: "Sign-in response delivered — run verify to finish." };
    },
    async stopInFlight(_env, stopInstanceId) {
      // Best effort: stop the auth process in the dedicated auth sandbox.
      await sandboxFor(sandboxIdFor(stopInstanceId))
        .exec("pkill -f 'agy' || true")
        .catch(() => undefined);
    },
    async onCleared(_env, clearInstanceId) {
      await sandboxFor(sandboxIdFor(clearInstanceId)).destroy?.().catch(() => undefined);
    },
  };
  return createAuthController(env, instanceId, hooks);
}
