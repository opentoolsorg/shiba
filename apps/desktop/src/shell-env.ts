import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MARKER = "\0__SHIBA_ENV__\0";
const CAPTURE_TIMEOUT_MS = 10_000;
const DROPPED = new Set(["SHIBA_WORKER_URL", "LOCAL_ADAPTER_TOKEN", "NODE_OPTIONS"]);

export type Env = Record<string, string>;

// Only text after the marker counts: rc files print banners before it.
export function parseEnv(stdout: string): Env | null {
  const at = stdout.lastIndexOf(MARKER);
  if (at < 0) return null;
  const env: Env = {};
  for (const entry of stdout.slice(at + MARKER.length).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : null;
}

// The daemon must never inherit the app's own secrets or Electron/Node injection vars.
export function sanitize(env: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (!DROPPED.has(k) && !k.startsWith("ELECTRON_")) out[k] = v;
  }
  return out;
}

export function fallbackEnv(base: NodeJS.ProcessEnv, home = homedir()): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")];
  const have = (env.PATH ?? "").split(delimiter).filter(Boolean);
  env.PATH = [...have, ...extra.filter((p) => !have.includes(p))].join(delimiter);
  return env;
}

export function captureShellEnv(
  base: NodeJS.ProcessEnv = process.env,
  shell: string | undefined = base.SHELL,
): Promise<Env> {
  return new Promise((resolve) => {
    const fallback = () => resolve(sanitize(fallbackEnv(base)));
    if (!shell) return fallback();
    execFile(
      shell,
      ["-ilc", 'printf "\\0__SHIBA_ENV__\\0"; env -0'],
      { timeout: CAPTURE_TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const parsed = err ? null : parseEnv(stdout);
        if (parsed) resolve(sanitize(parsed));
        else fallback();
      },
    );
  });
}
