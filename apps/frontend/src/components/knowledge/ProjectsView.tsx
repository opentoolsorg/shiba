import type {
  KnowledgeFile,
  KnowledgeNote,
  KnowledgeProject,
  KnowledgeProjectDetail,
} from "@shiba/shared";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";

const inputClass =
  "h-9 min-h-9 min-w-0 flex-1 rounded-[6px] border border-[var(--border-1)] bg-[var(--card)] px-3 text-sm text-[var(--fg)] outline-none transition-shadow focus-visible:border-[var(--border-3)] focus-visible:ring-[3px] focus-visible:ring-[var(--ring)]/20";
const buttonClass =
  "h-9 min-h-9 shrink-0 rounded-[8px] border border-[var(--border-1)] bg-[var(--panel)] px-4 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--card-hover)] disabled:opacity-50";

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error((body as { error?: string }).error ?? fallback);
  return body;
}

export function ProjectsView({
  onNavigate,
  workspaceId,
  workspaceRole,
  actorId,
}: {
  onNavigate?: (view: AppNavView) => void;
  workspaceId?: string | null;
  workspaceRole?: "owner" | "admin" | "member";
  actorId?: string;
} = {}): JSX.Element {
  const [projects, setProjects] = useState<KnowledgeProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeProjectDetail | null>(null);
  const [availableFiles, setAvailableFiles] = useState<KnowledgeFile[]>([]);
  const [availableNotes, setAvailableNotes] = useState<KnowledgeNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [rename, setRename] = useState("");
  const [fileChoice, setFileChoice] = useState("");
  const [noteChoice, setNoteChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceHeaders = useMemo(
    () => teamWorkspaceHeaders(workspaceId ?? undefined),
    [workspaceId],
  );

  const load = useCallback(async () => {
    const response = await fetch("/api/projects", {
      credentials: "same-origin",
      cache: "no-store",
      headers: workspaceHeaders,
    });
    const body = await readJson<{ projects?: KnowledgeProject[] }>(
      response,
      "Projects unavailable.",
    );
    if (!Array.isArray(body.projects)) throw new Error("Projects unavailable.");
    const firstProjectId = body.projects[0]?.id ?? null;
    setProjects(body.projects);
    setLoaded(true);
    setSelectedId((current) => current ?? firstProjectId);
  }, [workspaceHeaders]);

  const loadDetail = useCallback(
    async (projectId: string) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: workspaceHeaders,
      });
      const body = await readJson<KnowledgeProjectDetail>(response, "Project unavailable.");
      setDetail(body);
      setRename(body.project.name);
    },
    [workspaceHeaders],
  );

  const loadLibrary = useCallback(async () => {
    const [personalFiles, workspaceFiles, personalNotes, workspaceNotes] = await Promise.all([
      fetch("/api/files?scope=personal", {
        credentials: "same-origin",
        cache: "no-store",
        headers: workspaceHeaders,
      }).then((r) => readJson<{ files?: KnowledgeFile[] }>(r, "Files unavailable.")),
      fetch("/api/files?scope=workspace", {
        credentials: "same-origin",
        cache: "no-store",
        headers: workspaceHeaders,
      }).then((r) => readJson<{ files?: KnowledgeFile[] }>(r, "Files unavailable.")),
      fetch("/api/notes?scope=personal", {
        credentials: "same-origin",
        cache: "no-store",
        headers: workspaceHeaders,
      }).then((r) => readJson<{ notes?: KnowledgeNote[] }>(r, "Notes unavailable.")),
      fetch("/api/notes?scope=workspace", {
        credentials: "same-origin",
        cache: "no-store",
        headers: workspaceHeaders,
      }).then((r) => readJson<{ notes?: KnowledgeNote[] }>(r, "Notes unavailable.")),
    ]);
    setAvailableFiles([...(personalFiles.files ?? []), ...(workspaceFiles.files ?? [])]);
    setAvailableNotes([...(personalNotes.notes ?? []), ...(workspaceNotes.notes ?? [])]);
  }, [workspaceHeaders]);

  useEffect(() => {
    void load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : "Projects failed to load."),
    );
  }, [load]);
  useEffect(() => {
    if (selectedId)
      void loadDetail(selectedId).catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Project failed to load."),
      );
  }, [selectedId, loadDetail]);
  useEffect(() => {
    void loadLibrary().catch(() => {
      /* The picker remains unavailable; project contents still load. */
    });
  }, [loadLibrary]);

  const unassignedFiles = useMemo(
    () => availableFiles.filter((file) => file.projectId !== selectedId),
    [availableFiles, selectedId],
  );
  const unassignedNotes = useMemo(
    () => availableNotes.filter((note) => note.projectId !== selectedId),
    [availableNotes, selectedId],
  );

  async function mutate(input: RequestInit & { url: string }, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      const headers = new Headers(input.headers);
      for (const [key, value] of Object.entries(workspaceHeaders)) headers.set(key, value);
      const response = await fetch(input.url, { credentials: "same-origin", ...input, headers });
      await readJson(response, fallback);
      await Promise.all([
        load(),
        selectedId ? loadDetail(selectedId) : Promise.resolve(),
        loadLibrary(),
      ]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!name.trim()) return;
    const response = await fetch("/api/projects", {
      method: "POST",
      credentials: "same-origin",
      headers: { ...workspaceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    try {
      const body = await readJson<{ project?: KnowledgeProject }>(response, "Create failed.");
      setName("");
      if (body.project) setSelectedId(body.project.id);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Create failed.");
    }
  }

  async function setMembership(resourceKind: "file" | "note", resourceId: string, assign: boolean) {
    if (!selectedId) return;
    await mutate(
      {
        url: `/api/projects/${encodeURIComponent(selectedId)}/membership`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceKind, resourceId, assign }),
      },
      assign ? "Could not add the resource." : "Could not remove the resource.",
    );
    setFileChoice("");
    setNoteChoice("");
  }

  const project = detail?.project ?? null;
  const normalizedActorId = actorId?.trim().toLowerCase();
  const canMutateProject = !workspaceId ||
    workspaceRole === "owner" ||
    workspaceRole === "admin" ||
    Boolean(project?.createdBy && project.createdBy.trim().toLowerCase() === normalizedActorId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 flex-col justify-center border-b border-[var(--border-1)] px-6 py-1.5">
          <h1 className="text-sm leading-5 font-medium">Projects</h1>
          <p className="mt-0.5 text-xs leading-5 text-[var(--muted-foreground-2)]">
            Group files and notes into focused workspaces. Deleting a project keeps every file and
            note.
          </p>
      </header>
      <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-4 flex max-w-xl gap-2">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            aria-label="Project name"
          />
          <button
            type="button"
            className={buttonClass}
            disabled={!name.trim()}
            onClick={() => void create()}
          >
            Create
          </button>
        </div>
        {error ? <LoadErrorState message={error} onRetry={() => void load()} /> : null}
        {loaded && !projects.length && !error ? (
          <div className="rounded-[8px] border border-dashed border-[var(--border-1)] px-4 py-8 text-center text-sm">
            <h2 className="font-medium">No projects yet</h2>
            <p className="mt-1 text-[var(--muted-foreground-2)]">
              Name your first project above. A created project appears in this list.
            </p>
          </div>
        ) : null}
        {projects.length ? (
          <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
            <aside aria-label="Project list" className="space-y-2">
              {projects.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex min-h-12 w-full items-center justify-between rounded-[8px] border px-4 text-left text-sm transition-colors ${item.id === selectedId ? "border-[var(--border-2)] bg-[var(--panel)] font-medium" : "border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--card-hover)]"}`}
                >
                  <span className="truncate">{item.name}</span>
                  <span className="ml-2 shrink-0 rounded-[6px] bg-[var(--surface-subtle)] px-2 py-1 text-xs leading-none text-[var(--muted-foreground-2)]">
                    {(item.fileCount ?? 0) + (item.noteCount ?? 0)}
                  </span>
                </button>
              ))}
            </aside>
            <section
              aria-label="Project detail"
              className="min-w-0 rounded-[8px] border border-[var(--border-1)] p-4"
            >
              {project ? (
                <>
                  <div className="mb-4 flex flex-wrap gap-2">
                    <input
                      className={inputClass}
                      aria-label="Rename project"
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                    />
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={!canMutateProject || busy || !rename.trim() || rename.trim() === project.name}
                      onClick={() =>
                        void mutate(
                          {
                            url: `/api/projects/${encodeURIComponent(project.id)}`,
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name: rename }),
                          },
                          "Could not rename project.",
                        )
                      }
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={!canMutateProject || busy}
                      onClick={() => {
                        if (window.confirm(`Delete ${project.name}? Files and notes are kept.`))
                          void (async () => {
                            setBusy(true);
                            setError(null);
                            try {
                              const response = await fetch(
                                `/api/projects/${encodeURIComponent(project.id)}`,
                                {
                                  method: "DELETE",
                                  credentials: "same-origin",
                                  headers: workspaceHeaders,
                                },
                              );
                              await readJson(response, "Could not delete project.");
                              setSelectedId(null);
                              setDetail(null);
                              await Promise.all([load(), loadLibrary()]);
                            } catch (err: unknown) {
                              setError(
                                err instanceof Error ? err.message : "Could not delete project.",
                              );
                            } finally {
                              setBusy(false);
                            }
                          })();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  {!canMutateProject ? (
                    <p className="mb-3 text-xs text-[var(--muted-foreground-2)]">
                      Only the project creator or a workspace owner/admin can change this project.
                    </p>
                  ) : null}
                  <div className="grid gap-4 2xl:grid-cols-2">
                    <section aria-label="Project files" className="rounded-[8px] border border-[var(--border-1)] p-4">
                      <h2 className="mb-2 font-medium">
                        Files{" "}
                        <span className="text-xs text-[var(--muted-foreground-2)]">
                          {detail?.files.length ?? 0}
                        </span>
                      </h2>
                      <div className="mb-2 flex gap-2">
                        <select
                          aria-label="Choose file to add"
                          className={inputClass}
                          disabled={!canMutateProject}
                          value={fileChoice}
                          onChange={(e) => setFileChoice(e.target.value)}
                        >
                          <option value="">Choose a file…</option>
                          {unassignedFiles.map((file) => (
                            <option key={file.id} value={file.id}>
                              {file.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={!canMutateProject || busy || !fileChoice}
                          onClick={() => void setMembership("file", fileChoice, true)}
                        >
                          Add
                        </button>
                      </div>
                      <ul className="divide-y divide-[var(--border-1)] text-sm">
                        {detail?.files.map((file) => (
                          <li
                            key={file.id}
                            className="flex min-h-11 items-center justify-between gap-2 py-2"
                          >
                            <span className="truncate">{file.name}</span>
                            <button
                              type="button"
                              className="shrink-0 text-xs underline underline-offset-2"
                              disabled={!canMutateProject || busy}
                              onClick={() => void setMembership("file", file.id, false)}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                        {!detail?.files.length ? (
                          <li className="py-3 text-sm text-[var(--muted-foreground-2)]">
                            No files in this project.
                          </li>
                        ) : null}
                      </ul>
                    </section>
                    <section aria-label="Project notes" className="rounded-[8px] border border-[var(--border-1)] p-4">
                      <h2 className="mb-2 font-medium">
                        Notes{" "}
                        <span className="text-xs text-[var(--muted-foreground-2)]">
                          {detail?.notes.length ?? 0}
                        </span>
                      </h2>
                      <div className="mb-2 flex gap-2">
                        <select
                          aria-label="Choose note to add"
                          className={inputClass}
                          disabled={!canMutateProject}
                          value={noteChoice}
                          onChange={(e) => setNoteChoice(e.target.value)}
                        >
                          <option value="">Choose a note…</option>
                          {unassignedNotes.map((note) => (
                            <option key={note.id} value={note.id}>
                              {note.title}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={!canMutateProject || busy || !noteChoice}
                          onClick={() => void setMembership("note", noteChoice, true)}
                        >
                          Add
                        </button>
                      </div>
                      <ul className="divide-y divide-[var(--border-1)] text-sm">
                        {detail?.notes.map((note) => (
                          <li
                            key={note.id}
                            className="flex min-h-11 items-center justify-between gap-2 py-2"
                          >
                            <span className="truncate">{note.title}</span>
                            <button
                              type="button"
                              className="shrink-0 text-xs underline underline-offset-2"
                              disabled={!canMutateProject || busy}
                              onClick={() => void setMembership("note", note.id, false)}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                        {!detail?.notes.length ? (
                          <li className="py-3 text-sm text-[var(--muted-foreground-2)]">
                            No notes in this project.
                          </li>
                        ) : null}
                      </ul>
                    </section>
                  </div>
                </>
              ) : (
                <p className="text-sm text-[var(--muted-foreground-2)]">Choose a project.</p>
              )}
            </section>
          </div>
        ) : null}
        {onNavigate ? (
          <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">
            <button
              type="button"
              className="font-medium text-[var(--fg)] underline underline-offset-2"
              onClick={() => onNavigate("files")}
            >
              Browse files
            </button>
            {" · "}
            <button
              type="button"
              className="font-medium text-[var(--fg)] underline underline-offset-2"
              onClick={() => onNavigate("notes")}
            >
              Open notes
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
