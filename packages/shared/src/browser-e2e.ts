/**
 * Worker-side browser E2E plans (Phase 3). Pure types + parsing — no I/O.
 * The coding agent may drop `.shiba/browser-e2e.json` in the workdir;
 * when absent, the Worker runs a minimal smoke plan after publish.
 */

export const BROWSER_E2E_PLAN_PATHS = [".shiba/browser-e2e.json", "shiba-browser-e2e.json"] as const;

export const MAX_BROWSER_E2E_STEPS = 24;
export const MAX_BROWSER_E2E_SELECTOR_LEN = 512;
export const MAX_BROWSER_E2E_TEXT_LEN = 2000;

export type BrowserE2eStep =
  | { kind: "goto"; path: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; text: string }
  | { kind: "wait"; selector: string; timeoutMs?: number }
  | { kind: "screenshot"; name: string }
  | { kind: "assert_visible"; selector: string }
  | { kind: "assert_text"; selector: string; includes: string };

export interface BrowserE2ePlan {
  /** Optional human label for PR copy. */
  title?: string;
  steps: BrowserE2eStep[];
}

export interface BrowserE2eFrame {
  name: string;
  /** ATTACHMENTS object key. */
  key: string;
  /** Absolute public URL on this Worker when WORKER_HOSTNAME is set. */
  url: string | null;
  at: number;
}

export interface BrowserE2eManifest {
  sandboxId: string;
  planTitle: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  stepsRun: number;
  error?: string;
  frames: BrowserE2eFrame[];
  /** Same-origin preview base at capture time — never embed in public PR copy. */
  previewOrigin?: string;
}

/** Minimal smoke when the agent did not author a plan file. */
export const DEFAULT_BROWSER_E2E_PLAN: BrowserE2ePlan = {
  title: "smoke",
  steps: [
    { kind: "goto", path: "/" },
    { kind: "assert_visible", selector: "body" },
    { kind: "screenshot", name: "home" },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function parseStep(raw: unknown): BrowserE2eStep | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "goto": {
      const path = nonEmptyString(raw.path, 2048);
      if (!path || !path.startsWith("/")) return null;
      return { kind: "goto", path };
    }
    case "click": {
      const selector = nonEmptyString(raw.selector, MAX_BROWSER_E2E_SELECTOR_LEN);
      return selector ? { kind: "click", selector } : null;
    }
    case "fill": {
      const selector = nonEmptyString(raw.selector, MAX_BROWSER_E2E_SELECTOR_LEN);
      const text = nonEmptyString(raw.text, MAX_BROWSER_E2E_TEXT_LEN);
      if (!selector || text === null) return null;
      return { kind: "fill", selector, text };
    }
    case "wait": {
      const selector = nonEmptyString(raw.selector, MAX_BROWSER_E2E_SELECTOR_LEN);
      if (!selector) return null;
      const timeoutMs =
        typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
          ? Math.min(60_000, Math.max(100, Math.floor(raw.timeoutMs)))
          : undefined;
      return { kind: "wait", selector, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    }
    case "screenshot": {
      const name = nonEmptyString(raw.name, 64);
      if (!name || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) return null;
      return { kind: "screenshot", name };
    }
    case "assert_visible": {
      const selector = nonEmptyString(raw.selector, MAX_BROWSER_E2E_SELECTOR_LEN);
      return selector ? { kind: "assert_visible", selector } : null;
    }
    case "assert_text": {
      const selector = nonEmptyString(raw.selector, MAX_BROWSER_E2E_SELECTOR_LEN);
      const includes = nonEmptyString(raw.includes, MAX_BROWSER_E2E_TEXT_LEN);
      if (!selector || !includes) return null;
      return { kind: "assert_text", selector, includes };
    }
    default:
      return null;
  }
}

/** Parse a plan JSON blob. Never throws; invalid steps are dropped. */
export function parseBrowserE2ePlan(raw: unknown): { plan: BrowserE2ePlan | null; rejected: number } {
  if (!isRecord(raw)) return { plan: null, rejected: 0 };
  const title = raw.title === undefined ? undefined : nonEmptyString(raw.title, 120) ?? undefined;
  if (!Array.isArray(raw.steps)) return { plan: null, rejected: 0 };
  const steps: BrowserE2eStep[] = [];
  let rejected = 0;
  for (const item of raw.steps) {
    const step = parseStep(item);
    if (step) steps.push(step);
    else rejected += 1;
  }
  if (steps.length === 0) return { plan: null, rejected };
  if (steps.length > MAX_BROWSER_E2E_STEPS) {
    return { plan: { ...(title ? { title } : {}), steps: steps.slice(0, MAX_BROWSER_E2E_STEPS) }, rejected: rejected + steps.length - MAX_BROWSER_E2E_STEPS };
  }
  return { plan: { ...(title ? { title } : {}), steps }, rejected };
}
