/**
 * Approvals poller (T64). Pure logic only — electron's session fetch,
 * Notification, and the window are injected by main.ts, so this module is
 * testable under plain Node. D1: it never approves or rejects; the click
 * handler only opens the approvals view. D7: email-kind approvals carry a
 * mailbox address in repoUrl, so the body is a fixed label, never the
 * address.
 */

export type ApprovalKind = "run" | "email_send" | "email_delete";

export interface ApprovalLike {
  approvalId: string;
  repoUrl: string;
  kind?: ApprovalKind;
  createdAt?: number;
}

export interface ApprovalNotification {
  title: string;
  body: string;
}

export const APPROVALS_POLL_MS = 30_000;

/** "https://github.com/owner/repo" -> "owner/repo"; unparseable input passes through trimmed. */
export function repoSlug(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  try {
    const parts = new URL(trimmed).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1].replace(/\.git$/, "")}`;
    }
  } catch {
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join("/").replace(/\.git$/, "");
  }
  return trimmed;
}

/** D7: email kinds get a fixed label so the mailbox address never reaches a notification. */
export function approvalNotificationBody(approval: ApprovalLike): string {
  switch (approval.kind ?? "run") {
    case "email_send":
      return "Email send";
    case "email_delete":
      return "Email delete";
    default:
      return repoSlug(approval.repoUrl);
  }
}

export function approvalNotification(approval: ApprovalLike): ApprovalNotification {
  return { title: "Approval needed", body: approvalNotificationBody(approval) };
}

/** Pending approvals not in seen, oldest first. */
export function newApprovals(approvals: ApprovalLike[], seen: ReadonlySet<string>): ApprovalLike[] {
  return approvals
    .filter((a) => !seen.has(a.approvalId))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export interface FetchLikeResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface ApprovalsPollerDeps {
  /** session.defaultSession.fetch bound by main.ts — carries cookies. */
  fetch: (url: string) => Promise<FetchLikeResponse>;
  /** e.g. https://shiba.example.com/api/approvals */
  approvalsUrl: string;
  /** e.g. https://shiba.example.com/app/?tab=approvals */
  openUrl: string;
  /** Show/focus the window, then navigate — provided by main.ts. */
  showWindow: () => void;
  loadURL: (url: string) => Promise<unknown> | unknown;
  /** new Notification(...) — injected so this file stays electron-free. */
  notify: (n: ApprovalNotification, onClick: () => void) => void;
  log?: (...args: unknown[]) => void;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface ApprovalsPoller {
  /** Probes the endpoint; polling starts only after a 200. */
  start(): Promise<boolean>;
  stop(): void;
  toggle(): Promise<boolean>;
  isRunning(): boolean;
}

interface ApprovalsBody {
  approvals?: ApprovalLike[];
}

export function createApprovalsPoller(deps: ApprovalsPollerDeps): ApprovalsPoller {
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? APPROVALS_POLL_MS;
  const setI = deps.setIntervalFn ?? setInterval;
  const clearI = deps.clearIntervalFn ?? clearInterval;
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let seeded = false;
  let running = false;

  async function fetchApprovals(): Promise<ApprovalLike[] | null> {
    try {
      const res = await deps.fetch(deps.approvalsUrl);
      if (res.status !== 200) return null;
      const body = (await res.json()) as ApprovalsBody;
      return Array.isArray(body.approvals) ? body.approvals : [];
    } catch (error) {
      log("approvals poll failed:", error);
      return null;
    }
  }

  function openApprovals(): void {
    // D1: the notification can only surface the card — acting stays in the dashboard.
    deps.showWindow();
    void deps.loadURL(deps.openUrl);
  }

  async function poll(): Promise<void> {
    const approvals = await fetchApprovals();
    if (approvals === null) return;
    if (!seeded) {
      // First successful list seeds silently — pre-existing approvals don't notify.
      for (const a of approvals) seen.add(a.approvalId);
      seeded = true;
      return;
    }
    for (const approval of newApprovals(approvals, seen)) {
      seen.add(approval.approvalId);
      deps.notify(approvalNotification(approval), openApprovals);
    }
  }

  let starting: Promise<boolean> | undefined;
  // Bumped by stop(): a start() whose fetch outlives a stop() must not resume polling.
  let generation = 0;

  function begin(approvals: ApprovalLike[]): boolean {
    if (!seeded) {
      // First successful list seeds silently — pre-existing approvals don't notify.
      for (const a of approvals) seen.add(a.approvalId);
      seeded = true;
    } else {
      // Resume path: `seen` survives stop/start (suspend/resume), so
      // approvals queued while suspended notify instead of being re-seeded.
      for (const approval of newApprovals(approvals, seen)) {
        seen.add(approval.approvalId);
        deps.notify(approvalNotification(approval), openApprovals);
      }
    }
    running = true;
    timer = setI(() => void poll(), intervalMs);
    return true;
  }

  return {
    async start() {
      if (running) return true;
      // onStatus calls start on every state change: overlapping starts would leak an interval.
      if (starting) return starting;
      const gen = generation;
      // Own probe gate (§3.4): independent of the daemon probe.
      starting = fetchApprovals()
        .then((approvals) => (approvals === null || gen !== generation ? false : begin(approvals)))
        .finally(() => { starting = undefined; });
      return starting;
    },
    stop() {
      generation += 1;
      running = false;
      if (timer !== undefined) {
        clearI(timer);
        timer = undefined;
      }
    },
    async toggle() {
      if (running) {
        this.stop();
        return false;
      }
      return this.start();
    },
    isRunning() {
      return running;
    },
  };
}
