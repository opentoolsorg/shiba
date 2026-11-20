import type { RunSignal } from "@shiba/shared";
import { scopedExec } from "./exec-allowlist.js";
import { redactSecrets, shellJoin } from "./security.js";
import type { SandboxOps } from "./runtime.js";

export const SCREEN_INTAKE_PREFIX = "screen:";
export const SCREEN_FRAME_BASE64_LIMIT = 500_000;
const SCREEN_TIMEOUT_MS = 8_000;
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;
const MAX_SCROLL_DELTA = 100_000;
const MAX_TYPE_CHARS = 4_000;
const MAX_SCROLL_TICKS = 100;
const MAX_KEYS = 16;
const SCREENSHOT_PATH = "/tmp/shiba-screen.png";

/** xdotool mouse buttons. */
const BUTTON_IDS = { left: 1, middle: 2, right: 3 } as const;
type ButtonName = keyof typeof BUTTON_IDS;

export type ScreenAction =
  | { type: "click"; x: number; y: number; button?: ButtonName | 1 | 2 | 3 }
  | { type: "type"; text: string }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "key"; keys: string }
  | { type: "shot" };

const SCREEN_EXEC_ALLOWLIST = [["shiba-run-computer", "action"], ["shiba-run-computer", "control"]] as const;

/** Input failed validation before it could become argv. */
export class ScreenActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenActionError";
  }
}

const coord = (value: unknown, name: string, max: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ScreenActionError(`${name} must be an integer in [0, ${max}].`);
  }
  return value;
};

/** xdotool key names are a small closed alphabet — anything else refuses. */
const XDOTOOL_CHAIN_COMMANDS = new Set([
  "exec",
  "key",
  "type",
  "mousemove",
  "click",
  "getwindowfocus",
  "search",
  "selectwindow",
]);

const KEY_MODIFIER = /^(?:shift|alt|ctrl|meta|super)$/i;

const KEY_SINGLE =
  /^(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-9]|3[0-5])|Return|Escape|Tab|space|BackSpace|Delete|Insert|Home|End|Page_Up|Page_Down|Left|Right|Up|Down|Print|plus|minus)$/i;

function assertKeyChord(chord: string): void {
  const tokens = chord.split("+");
  if (tokens.length === 0 || tokens.some((token) => token === "")) {
    throw new ScreenActionError("Invalid key chord.");
  }
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (XDOTOOL_CHAIN_COMMANDS.has(lower)) {
      throw new ScreenActionError("Invalid key name.");
    }
    if (!(KEY_MODIFIER.test(token) || KEY_SINGLE.test(token))) {
      throw new ScreenActionError("Invalid key name.");
    }
  }
}

const buttonId = (button: ButtonName | 1 | 2 | 3 | undefined): number => {
  if (button === undefined) return 1;
  if (button === 1 || button === 2 || button === 3) return button;
  if (button === "left" || button === "middle" || button === "right") return BUTTON_IDS[button];
  throw new ScreenActionError("button must be left, middle, or right.");
};

/**
 * `zod`-free structural validation — the caller is the DO, which already
 * holds the parsed body. Returns the argv arrays to exec, in order.
 */
export function screenActionArgv(action: ScreenAction): string[][] {
  switch (action.type) {
    case "click": {
      const x = coord(action.x, "x", SCREEN_WIDTH - 1);
      const y = coord(action.y, "y", SCREEN_HEIGHT - 1);
      const b = buttonId(action.button);
      return [
        ["xdotool", "mousemove", String(x), String(y)],
        ["xdotool", "click", String(b)],
      ];
    }
    case "type": {
      if (typeof action.text !== "string" || action.text.length === 0) {
        throw new ScreenActionError("text must be a non-empty string.");
      }
      if (action.text.length > MAX_TYPE_CHARS) {
        throw new ScreenActionError(`text is capped at ${MAX_TYPE_CHARS} characters.`);
      }
      if (action.text.includes("\0") || redactSecrets(action.text) !== action.text) {
        throw new ScreenActionError("Screen text must not contain credentials or control bytes.");
      }
      // End-of-options keeps leading-dash text literal for xdotool's parser.
      return [["xdotool", "type", "--delay", "15", "--", action.text]];
    }
    case "scroll": {
      if (typeof action.dx !== "number" || typeof action.dy !== "number") {
        throw new ScreenActionError("Scroll deltas must be integers.");
      }
      const dx = coord(Math.abs(action.dx), "|dx|", MAX_SCROLL_DELTA);
      const dy = coord(Math.abs(action.dy), "|dy|", MAX_SCROLL_DELTA);
      if (action.dx === 0 && action.dy === 0) {
        throw new ScreenActionError("a scroll needs a nonzero dx or dy.");
      }
      const argv: string[][] = [];
      // xdotool scrolls through button clicks: 4 up, 5 down, 6 left, 7 right.
      const ticks = (v: number) => Math.min(MAX_SCROLL_TICKS, Math.max(1, Math.round(v / 120) || 1));
      if (action.dy !== 0) {
        argv.push(["xdotool", "click", "--repeat", String(ticks(Math.abs(action.dy))), action.dy < 0 ? "4" : "5"]);
      }
      if (action.dx !== 0) {
        argv.push(["xdotool", "click", "--repeat", String(ticks(Math.abs(action.dx))), action.dx < 0 ? "6" : "7"]);
      }
      return argv;
    }
    case "key": {
      if (typeof action.keys !== "string" || !action.keys.trim()) {
        throw new ScreenActionError("keys must be a non-empty string.");
      }
      const keys = action.keys.trim().split(/\s+/);
      if (keys.length > MAX_KEYS) {
        throw new ScreenActionError(`at most ${MAX_KEYS} keys per call.`);
      }
      for (const key of keys) {
        assertKeyChord(key);
      }
      return [["xdotool", "key", ...keys]];
    }
    case "shot":
      return [
        ["scrot", "-o", SCREENSHOT_PATH],
        ["base64", "-w0", SCREENSHOT_PATH],
      ];
    default:
      throw new ScreenActionError("Unknown screen action.");
  }
}

export interface ScreenActionResult {
  ok: boolean;
  screenshotBase64?: string;
  paused?: true;
}

export function decodeScreenPng(base64: string): Uint8Array<ArrayBuffer> | null {
  if (!base64.startsWith("iVBORw0KGgo") || base64.length > SCREEN_FRAME_BASE64_LIMIT) return null;
  try {
    const bytes = Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
    const end = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
    return bytes.length >= 45 && end.every((value, index) => bytes[bytes.length - end.length + index] === value)
      ? bytes : null;
  } catch {
    return null;
  }
}

export async function runScreenAction(
  ops: SandboxOps,
  action: ScreenAction,
  actor: "agent" | "human" | "view",
  signals?: RunSignal[],
): Promise<ScreenActionResult> {
  const result = await scopedExec(
    ops, shellJoin(["shiba-run-computer", "action", actor, JSON.stringify(screenActionArgv(action))]),
    { timeoutMs: SCREEN_TIMEOUT_MS, allowlist: SCREEN_EXEC_ALLOWLIST, signals, activeOnly: true,
      receiptLabel: `screen_${action.type}`, maxOutputChars: SCREEN_FRAME_BASE64_LIMIT },
  );
  if (result.exitCode !== 0) return { ok: false, ...(result.exitCode === 75 ? { paused: true } : {}) };
  if (action.type === "shot") {
    const screenshotBase64 = result.stdout.trim();
    return decodeScreenPng(screenshotBase64) ? { ok: true, screenshotBase64 } : { ok: false };
  }
  return { ok: true };
}

export async function setScreenControl(ops: SandboxOps, operation: "take" | "release", expiresAt: number): Promise<boolean> {
  const result = await scopedExec(ops, shellJoin(["shiba-run-computer", "control", operation, String(expiresAt)]), {
    timeoutMs: SCREEN_TIMEOUT_MS, allowlist: SCREEN_EXEC_ALLOWLIST, activeOnly: true,
  });
  return result.exitCode === 0;
}

export async function readScreenRequest(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(25_000);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.byteLength > bytes.length) return null;
      bytes.set(part.value, used);
      used += part.value.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
