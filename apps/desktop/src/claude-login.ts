import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/** Fixed argv. The renderer cannot choose the binary or the arguments. */
export const CLAUDE_LOGIN_COMMAND = "claude";
export const CLAUDE_LOGIN_ARGS = ["auth", "login"] as const;
export const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export type ClaudeSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "ignore"; windowsHide: boolean },
) => ChildProcess;

export type ClaudeLoginResult = { ok: true } | { ok: false; error: string };

/**
 * Runs `claude auth login` with the operator's shell environment.
 * Output is ignored so a token printed by the CLI never reaches logs or the renderer.
 */
export function startClaudeLogin(deps: {
  spawn?: ClaudeSpawn;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ClaudeLoginResult> {
  const spawn = deps.spawn ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(CLAUDE_LOGIN_COMMAND, CLAUDE_LOGIN_ARGS, {
        env: deps.env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve({
        ok: false,
        error: "Claude Code could not be started. Install it, then try again.",
      });
      return;
    }
    let settled = false;
    const finish = (result: ClaudeLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "Claude sign-in timed out." });
    }, timeoutMs);
    child.once("error", () => {
      finish({ ok: false, error: "Claude Code is not installed on this computer." });
    });
    child.once("exit", (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: "Claude sign-in did not finish." });
    });
  });
}
