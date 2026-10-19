import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { extractCompletedDiff } from "../ui-helpers";
import type { VMRun } from "../types";

type WorkspaceTab = "changes" | "desktop" | "terminal" | "files";

export interface TaskWorkspacePanelProps {
  run: VMRun | null;
  loading?: boolean;
}

interface DesktopSession {
  status: string;
  inputMode?: "agent" | "human";
  embedPath?: string;
  detail?: string;
}

export function TaskWorkspacePanel({ run, loading = false }: TaskWorkspacePanelProps): JSX.Element {
  const [tab, setTab] = useState<WorkspaceTab>("changes");
  const [desktop, setDesktop] = useState<DesktopSession | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [filesPath, setFilesPath] = useState<string>("");
  const [files, setFiles] = useState<unknown[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);

  const diff = useMemo(() => {
    if (!run) return null;
    return extractCompletedDiff(run) ?? run.diff ?? null;
  }, [run]);

  const workdir = run ? `/workspace/${run.sandboxId}` : "";

  const refreshDesktop = useCallback(async () => {
    if (!run?.runId) return;
    setDesktopError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/workspace/desktop`);
      const body = (await res.json()) as { desktop?: DesktopSession; error?: string };
      if (!res.ok) {
        setDesktopError(body.error ?? `Desktop unavailable (${res.status}).`);
        setDesktop(null);
        return;
      }
      setDesktop(body.desktop ?? null);
    } catch (error) {
      setDesktopError(error instanceof Error ? error.message : "Desktop request failed.");
    }
  }, [run?.runId]);

  const refreshLogs = useCallback(async () => {
    if (!run?.runId) return;
    const res = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/workspace/logs`);
    if (!res.ok) return;
    const body = (await res.json()) as { lines?: string[] };
    setLogs(body.lines ?? []);
  }, [run?.runId]);

  const refreshFiles = useCallback(
    async (path: string) => {
      if (!run?.runId) return;
      setFilesPath(path);
      const res = await fetch(
        `/api/runs/${encodeURIComponent(run.runId)}/workspace/files?path=${encodeURIComponent(path)}`,
      );
      const body = (await res.json()) as { files?: unknown[] };
      setFiles(body.files ?? []);
      setFileContent(null);
    },
    [run?.runId],
  );

  useEffect(() => {
    if (!run?.runId) return;
    if (tab === "desktop") refreshDesktop();
    if (tab === "terminal") refreshLogs();
    if (tab === "files" && !filesPath) refreshFiles(workdir);
  }, [tab, run?.runId, refreshDesktop, refreshLogs, refreshFiles, filesPath, workdir]);

  useEffect(() => {
    if (tab !== "terminal" || !run?.runId) return;
    const timer = window.setInterval(refreshLogs, 3000);
    return () => window.clearInterval(timer);
  }, [tab, run?.runId, refreshLogs]);

  const setControlMode = async (mode: "agent" | "human") => {
    if (!run?.runId) return;
    setControlBusy(true);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/workspace/desktop/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDesktopError(body.error ?? "Control update failed.");
        return;
      }
      await refreshDesktop();
    } finally {
      setControlBusy(false);
    }
  };

  const tabs: { id: WorkspaceTab; label: string }[] = [
    { id: "changes", label: "Changes" },
    { id: "desktop", label: "Desktop" },
    { id: "terminal", label: "Terminal" },
    { id: "files", label: "Files" },
  ];

  return (
    <aside
      className="hidden xl:flex flex-col w-[min(420px,38vw)] border-l border-[var(--border-1)] bg-[var(--panel)] min-h-0 shrink-0"
      aria-label="Task workspace"
    >
      <div className="flex items-center gap-1 px-2 py-2 border-b border-[var(--border-1)] shrink-0">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`text-xs font-medium px-2.5 py-1.5 rounded-[var(--radius-button)] transition-colors ${
              tab === entry.id
                ? "bg-[var(--card)] text-[var(--fg)] border border-[var(--border-1)]"
                : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 text-sm">
        {!run ? (
          <p className="text-xs text-[var(--muted-foreground-2)]">Select a task to inspect workspace output.</p>
        ) : tab === "changes" ? (
          loading ? (
            <p className="text-xs text-[var(--muted-foreground-2)]">Loading run details…</p>
          ) : diff ? (
            <DiffViewer diff={diff} runId={run.runId} />
          ) : (
            <p className="text-xs text-[var(--muted-foreground-2)]">No diff captured yet for this run.</p>
          )
        ) : tab === "desktop" ? (
          <div className="flex flex-col gap-2 h-full min-h-[280px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-[var(--muted-foreground-2)]">
                {desktop?.status === "ready"
                  ? `View-only${desktop.inputMode === "human" ? " · you have control" : ""}`
                  : desktop?.status ?? "Checking…"}
              </span>
              <div className="flex gap-1">
                {desktop?.inputMode !== "human" ? (
                  <button
                    type="button"
                    disabled={controlBusy || desktop?.status !== "ready"}
                    onClick={() => setControlMode("human")}
                    className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-[var(--radius-button)] border border-[var(--border-1)] hover:bg-[var(--card)] disabled:opacity-50"
                  >
                    Take control
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={controlBusy}
                    onClick={() => setControlMode("agent")}
                    className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-[var(--radius-button)] border border-[var(--primary)]/30 text-[var(--primary)] hover:bg-[var(--primary-soft)] disabled:opacity-50"
                  >
                    Hand back
                  </button>
                )}
              </div>
            </div>
            {desktopError ? (
              <p className="text-xs text-[var(--destructive)]">{desktopError}</p>
            ) : null}
            {desktop?.embedPath ? (
              <iframe
                title="Sandbox desktop stream"
                src={desktop.embedPath}
                className="flex-1 w-full min-h-[240px] rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)]"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center rounded-[var(--radius-button)] border border-dashed border-[var(--border-1)] text-xs text-[var(--muted-foreground-2)]">
                {desktop?.status === "disabled"
                  ? "Desktop layer is off (set SHIBA_SANDBOX_DESKTOP=1)."
                  : desktop?.detail ?? "Desktop will appear when the sandbox is running."}
              </div>
            )}
          </div>
        ) : tab === "terminal" ? (
          <pre className="text-[11px] font-mono whitespace-pre-wrap text-[var(--muted-foreground-2)] leading-relaxed">
            {logs.length > 0 ? logs.join("\n") : "No exec log lines yet — output appears as the agent runs commands."}
          </pre>
        ) : (
          <div className="flex flex-col gap-2 min-h-0">
            <p className="text-[10px] font-mono text-[var(--muted-foreground-2)] truncate">{filesPath || workdir}</p>
            <ul className="text-xs font-mono space-y-1">
              {files.map((entry, index) => {
                const name =
                  typeof entry === "object" && entry !== null && "name" in entry
                    ? String((entry as { name: unknown }).name)
                    : String(entry);
                const isDir =
                  typeof entry === "object" && entry !== null && "type" in entry
                    ? (entry as { type?: string }).type === "directory"
                    : name.endsWith("/");
                const nextPath = `${filesPath.replace(/\/$/, "")}/${name}`.replace("//", "/");
                return (
                  <li key={`${name}-${index}`}>
                    <button
                      type="button"
                      className="text-left hover:text-[var(--primary)] w-full truncate"
                      onClick={() => {
                        if (isDir) refreshFiles(nextPath);
                        else {
                          fetch(
                            `/api/runs/${encodeURIComponent(run.runId)}/workspace/file?path=${encodeURIComponent(nextPath)}`,
                          )
                            .then((r) => r.json())
                            .then((body) => {
                              const record = body as { content?: string };
                              setFileContent(record.content ?? "");
                            });
                        }
                      }}
                    >
                      {isDir ? `${name}/` : name}
                    </button>
                  </li>
                );
              })}
            </ul>
            {fileContent !== null ? (
              <pre className="text-[11px] font-mono mt-2 p-2 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] overflow-x-auto max-h-48">
                {fileContent}
              </pre>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
