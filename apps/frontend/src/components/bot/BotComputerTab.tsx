import type { RunStatus } from "@shiba/shared";
import { BotSectionState, botRunsScopeNote, type BotRunsScope } from "./BotPanel";

export interface BotPairedComputer {
  machineId: string;
  hostname?: string;
  state: "ready" | "busy" | "offline" | "incompatible";
}

export interface BotRuntimeInfo {
  harness?: string;
  sandboxProvider?: string;
  /** Whether this workspace can run the bot on a paired computer right now. */
  localAvailable: boolean;
  /** Paired computers, including ones that are busy, offline or unable to run this harness. */
  paired: readonly BotPairedComputer[];
  loading: boolean;
  error: string | null;
}

const PAIRED_STATE_LABEL: Record<BotPairedComputer["state"], string> = {
  ready: "Ready",
  busy: "In use",
  offline: "Offline",
  incompatible: "Can't run this harness",
};

export interface BotRunRow {
  runId: string;
  status: RunStatus;
  task: string;
  createdAt: number;
  updatedAt: number;
}

const RUN_TONE: Partial<Record<RunStatus, string>> = {
  completed: "text-[var(--fg)]",
  running: "text-[var(--primary)]",
  pending: "text-[var(--muted-foreground-1)]",
  error: "text-[var(--destructive)]",
  unknown: "text-[var(--muted-foreground-2)]",
};

const relative = (timestamp: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

export function BotComputerTab({
  runtime,
  configuredHarness,
  configuredSandbox,
  connectionId,
  runs,
  runsScope,
  pendingApprovals = 0,
  onOpenRun,
  onOpenApprovals,
}: {
  runtime?: BotRuntimeInfo;
  configuredHarness?: string;
  configuredSandbox?: string;
  connectionId?: string;
  runs: readonly BotRunRow[];
  /** Which conversation these runs were read from, and whether the read landed. */
  runsScope?: BotRunsScope;
  /** Queued tasks for this bot that are waiting on a person, from the approval queue. */
  pendingApprovals?: number;
  onOpenRun?: (runId: string) => void;
  onOpenApprovals?: () => void;
}) {
  const paired = runtime?.paired ?? [];
  const cloudSandbox = runtime?.sandboxProvider ?? configuredSandbox;
  const waiting = pendingApprovals;
  return (
    <div role="tabpanel" id="agent-panel-computer" aria-labelledby="agent-tab-computer" className="flex flex-col gap-4 pt-2">
      <section aria-labelledby="bot-computer-where" className="flex flex-col gap-2">
        <h3 id="bot-computer-where" className="text-xs font-medium text-[var(--muted-foreground-2)]">Where this bot runs</h3>
        <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
          Nothing starts until a person approves the frozen task. Shiba creates the machine per approved run; a bot does
          not own a computer between runs.
        </p>
        <dl className="divide-y divide-[var(--border-1)] rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3">
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-xs text-[var(--muted-foreground-2)]">Harness</dt>
            <dd className="min-w-0 truncate font-mono text-xs">{runtime?.harness || configuredHarness || "Workspace default"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-xs text-[var(--muted-foreground-2)]">Cloud sandbox</dt>
            <dd className="min-w-0 truncate text-right font-mono text-xs">{cloudSandbox ?? "Deployment default"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-xs text-[var(--muted-foreground-2)]">Paired computers</dt>
            <dd className="min-w-0 truncate text-right text-xs">
              {runtime?.loading
                ? "Checking…"
                : runtime?.error
                  ? "Unknown"
                  : paired.length > 0
                    ? `${paired.filter((computer) => computer.state === "ready").length} of ${paired.length} ready`
                    : "None paired"}
            </dd>
          </div>
          {connectionId ? (
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-xs text-[var(--muted-foreground-2)]">Connection</dt>
              <dd className="min-w-0 truncate font-mono text-xs">{connectionId}</dd>
            </div>
          ) : null}
        </dl>
        {paired.length > 0 ? (
          <ul aria-label="Paired computer states" className="flex flex-col gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-[11px]">
            {paired.map((computer) => (
              <li key={computer.machineId} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[var(--fg)]">{computer.hostname || computer.machineId}</span>
                <span className={computer.state === "ready" ? "shrink-0 text-[var(--fg)]" : "shrink-0 text-[var(--muted-foreground-2)]"}>
                  {PAIRED_STATE_LABEL[computer.state]}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {runtime?.error ? (
          <p role="alert" className="text-[11px] text-[var(--destructive)]">Paired computers could not be checked: {runtime.error}</p>
        ) : null}
        {runtime && !runtime.loading && !runtime.error && paired.length > 0 && !runtime.localAvailable ? (
          <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            {paired.every((computer) => computer.state === "incompatible")
              ? `Local execution cannot run ${runtime.harness || "this harness"} on a paired computer. Change the harness, or start the bot in the cloud sandbox.`
              : "No paired computer can start this bot right now. Free one up in Settings → Computers, or start it in the cloud sandbox."}
          </p>
        ) : null}
        {runtime && !runtime.loading && !runtime.error && paired.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            No computer is paired with this workspace. Pair one in Settings → Computers, or start the bot in the cloud sandbox.
          </p>
        ) : null}
        <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
          {cloudSandbox
            ? "A cloud run starts in this sandbox only after you approve the task."
            : "Without an override this bot runs in the deployment's sandbox: the workspace's provider, or the deployment's own fallback. Nothing starts until you approve the task."}
        </p>
        <BotSectionState>
          A persistent bot computer — one machine a bot keeps between runs — does not exist in Shiba. Runs are created per
          approval, so there is no bot machine to wake, reserve or take over here.
        </BotSectionState>
      </section>

      <section aria-labelledby="bot-computer-runs" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id="bot-computer-runs" className="text-xs font-medium text-[var(--muted-foreground-2)]">Approved runs</h3>
          <p className="font-mono text-[10px] text-[var(--muted-foreground-2)]">{runs.length} recent</p>
        </div>
        {runsScope?.threadName ? (
          <p className="text-[11px] text-[var(--muted-foreground-2)]">Runs started in {runsScope.threadName}.</p>
        ) : null}
        {runs.length === 0 ? (
          <BotSectionState>
            {runsScope?.state === "loading"
              ? "Loading this bot's runs…"
              : runsScope?.state === "error"
                ? "This bot's runs could not be read just now. Reload to try again."
                : `No run from this bot${runsScope?.threadName ? ` in ${runsScope.threadName}` : ""} yet. Queue a task and it waits for approval before anything starts.`}
          </BotSectionState>
        ) : (
          <ul aria-label="Approved runs" className="flex flex-col gap-1.5">
            {runs.slice(0, 6).map((run) => (
              <li key={run.runId} className="rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${RUN_TONE[run.status] ?? "text-[var(--muted-foreground-2)]"}`}>{run.status}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--fg)]">{run.task || run.runId.slice(0, 12)}</span>
                  <time dateTime={new Date(run.updatedAt).toISOString()} className="shrink-0 text-[10px] text-[var(--muted-foreground-2)]">{relative(run.updatedAt)}</time>
                </div>
                {onOpenRun ? (
                  <button type="button" onClick={() => onOpenRun(run.runId)} className="mt-1 text-[11px] text-[var(--primary)] underline">
                    Open this run
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {botRunsScopeNote(runsScope) ? <BotSectionState>{botRunsScopeNote(runsScope)}</BotSectionState> : null}
        {waiting > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-foreground-2)]">
            <span>{waiting} task{waiting === 1 ? "" : "s"} waiting for approval.</span>
            {onOpenApprovals ? <button type="button" onClick={onOpenApprovals} className="text-[var(--primary)] underline">Open approvals</button> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
