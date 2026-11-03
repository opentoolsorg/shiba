import { useEffect, useMemo, useRef, useState } from "react";
import { RunLivePanel } from "./RunLivePanel";
import { LoadErrorState } from "./LoadErrorState";

interface CanvasApproval {
  approvalId: string;
  task: string;
  workspaceLabel: string;
}

interface CanvasRun {
  runId: string;
  status: string;
  task: string;
  workspaceLabel: string;
  summary?: string;
  error?: string;
  pullUrl?: string;
}

type CanvasData =
  | { state: "pending"; approval: CanvasApproval }
  | { state: "run"; run: CanvasRun; room: { sessionId: string; runId: string } };

type CanvasState =
  | { scope: string; kind: "loading" }
  | { scope: string; kind: "error"; message: string }
  | { scope: string; kind: "ready"; data: CanvasData };

const POLL_MS = 5_000;
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled", "aborted", "unknown"]);

function locatorFromSearch(search: string): URLSearchParams | null {
  const params = new URLSearchParams(search);
  if (params.getAll("origin").length !== 1 || params.getAll("approval").length !== 1) return null;
  const origin = params.get("origin") ?? "";
  const approval = params.get("approval") ?? "";
  if (!origin || origin.length > 512 || !approval || approval.length > 200) return null;
  return new URLSearchParams({ origin, approval });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCanvasData(value: unknown, approvalId: string): CanvasData {
  if (!isRecord(value)) throw new Error("The run view returned an invalid response.");
  if (value.state === "pending" && isRecord(value.approval) &&
    value.approval.approvalId === approvalId && typeof value.approval.task === "string" &&
    typeof value.approval.workspaceLabel === "string") {
    return value as unknown as CanvasData;
  }
  const run = value.run;
  const room = value.room;
  if (value.state === "run" && isRecord(run) && isRecord(room) &&
    run.runId === `agent-tool:${approvalId}` && room.runId === run.runId &&
    typeof run.status === "string" && typeof run.task === "string" &&
    typeof run.workspaceLabel === "string" && typeof room.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(room.sessionId) &&
    ["summary", "error", "pullUrl"].every((key) => run[key] === undefined || typeof run[key] === "string")) {
    return value as unknown as CanvasData;
  }
  throw new Error("The run view returned an invalid response.");
}

function safePullUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** This surface observes one protected Slack run without mounting the chat coordinator. */
export function SlackRunCanvas({ search }: { search: string }) {
  const locator = useMemo(() => locatorFromSearch(search), [search]);
  const scope = locator?.toString() ?? "";
  const [refresh, setRefresh] = useState(0);
  const requestIdentity = JSON.stringify([scope, refresh]);
  const activeRequest = useRef(requestIdentity);
  activeRequest.current = requestIdentity;
  const [stored, setState] = useState<CanvasState>({ scope, kind: "loading" });
  const state: CanvasState = stored.scope === scope ? stored : { scope, kind: "loading" };

  useEffect(() => {
    if (!locator) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/slack-canvas?${scope}`, {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(isRecord(body) && typeof body.error === "string"
            ? body.error.slice(0, 2_000)
            : `The run view is unavailable (${response.status}).`);
        }
        const data = readCanvasData(body, locator.get("approval") ?? "");
        if (stopped || activeRequest.current !== requestIdentity) return;
        setState({ scope, kind: "ready", data });
        if (data.state === "pending" || !TERMINAL_STATUSES.has(data.run.status)) timer = setTimeout(() => { void load(); }, POLL_MS);
      } catch (error: unknown) {
        if (stopped || activeRequest.current !== requestIdentity) return;
        setState({ scope, kind: "error", message: error instanceof Error ? error.message : "The run view is unavailable." });
      }
    };
    setState({ scope, kind: "loading" });
    void load();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [locator, requestIdentity, scope]);

  const data = state.kind === "ready" ? state.data : null;
  const target = data?.state === "pending" ? data.approval : data?.run;
  const run = data?.state === "run" ? data.run : null;
  const pullUrl = safePullUrl(run?.pullUrl);

  return (
    <main className="min-h-dvh min-w-0 bg-[var(--paper)] px-4 py-6 text-[var(--ink)] sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="border border-[var(--line)] bg-[var(--card)] p-4">
          <h1 className="font-display text-2xl">Slack run canvas</h1>
          <p className="mt-1 text-xs text-[var(--ink-2)]">Read only. Approve actions in Slack.</p>
        </header>
        {!locator ? <p role="alert" className="text-sm text-[var(--danger)]">This run link is invalid.</p> : null}
        {locator && state.kind === "loading" ? <p role="status" className="text-sm text-[var(--ink-2)]">Checking access to this run…</p> : null}
        {locator && state.kind === "error" ? <LoadErrorState message={state.message} onRetry={() => setRefresh((current) => current + 1)} /> : null}
        {target ? (
          <section aria-label="Slack task" className="min-w-0 border border-[var(--line)] bg-[var(--card)] p-4">
            <h2 className="font-mono text-xs uppercase tracking-wide text-[var(--ink-2)]">Target workspace</h2>
            <p className="mt-1 break-words text-sm">{target.workspaceLabel}</p>
            <h2 className="mt-4 font-mono text-xs uppercase tracking-wide text-[var(--ink-2)]">Task</h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{target.task}</p>
            {data?.state === "pending" ? <p role="status" className="mt-4 text-sm text-[var(--ink-2)]">Awaiting approval in Slack. Execution has not started.</p> : null}
            {run ? <p role="status" className="mt-4 font-mono text-xs">{run.status.replaceAll("_", " ")}</p> : null}
            {run?.summary ? <p className="mt-2 whitespace-pre-wrap break-words text-sm">{run.summary}</p> : null}
            {run?.error ? <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--danger)]">{run.error}</p> : null}
            {pullUrl ? <a className="mt-3 inline-block text-sm underline" href={pullUrl} target="_blank" rel="noreferrer">View pull request</a> : null}
          </section>
        ) : null}
        {data?.state === "run" ? (
          <RunLivePanel
            key={`${scope}:${data.run.runId}`}
            runId={data.run.runId}
            sessionId={data.room.sessionId}
            roomUrl={`/api/slack-canvas/websocket?${scope}`}
          />
        ) : null}
      </div>
    </main>
  );
}
