/**
 * The shell's own copy for the failures its IPC answers can produce. It cannot
 * import the shared table (Electron's main process loads plain CJS, and
 * @shiba/shared publishes TypeScript source), so test/pair-copy.test.ts locks
 * these strings to PAIR_FAILURE_MESSAGES in one pass.
 */
import type { PairFailureCode, PairResult } from "@shiba/shared";

const PAIR_FAILURE_COPY = {
  pairing_deferred:
    "Connecting this computer runs from the browser: open Shiba there and use Add computer.",
  untrusted_sender: "Shiba Desktop refused a request that did not come from its own window.",
  pairing_busy: "A connection change is already running.",
  url_invalid: "That is not a Shiba address. Use https:// (http://localhost only in dev).",
  url_wrong_frame: "Only the setup page can change the address.",
  revoke_failed: "Could not disconnect this computer. Check the connection and retry.",
  revoke_unreachable: "Could not reach your Shiba to disconnect this computer.",
} as const satisfies Partial<Record<PairFailureCode, string>>;

export type ShellPairFailureCode = keyof typeof PAIR_FAILURE_COPY;

export const PAIR_FAILURE_COPY_TABLE: Readonly<Record<ShellPairFailureCode, string>> =
  PAIR_FAILURE_COPY;

/**
 * A refusal that still renders on a dashboard that predates typed codes: those
 * pages read `result.error`, so the sentence ships beside the code. It is
 * always one of the constants above, never text from the daemon or the page.
 */
export function shellFailure(code: ShellPairFailureCode): PairResult {
  return { ok: false, code, error: PAIR_FAILURE_COPY[code] };
}
