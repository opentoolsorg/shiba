import type {
  KnowledgeFile,
  KnowledgeNote,
  KnowledgeProject,
  KnowledgeProjectDetail,
} from "@shiba/shared";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";

const inputClass =
  "min-h-11 flex-1 border border-[var(--border-1)] bg-[var(--card)] px-3 text-sm text-[var(--fg)]";
const buttonClass =
  "min-h-11 border border-[var(--border-1)] bg-[var(--panel)] px-3 text-sm text-[var(--fg)]";

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error((body as { error?: string }).error ?? fallback);
  return body;
}

export function ProjectsView({
  onNavigate,
}: {
  onNavigate?: (view: AppNavView) => void;
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

  const load = useCallback(async () => {
    const response = await fetch("/api/projects", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await readJson<{ projects?: KnowledgeProject[] }>(
      response,
      "Projects unavailable.",
    );
    if (!Array.isArray(body.projects)) throw new Error("Projects unavailable.");
    setProjects(body.projects);
    setLoaded(true);
    if (!selectedId && body.projects[0]) setSelectedId(body.projects[0].id);
  }, [selectedId]);

  const loadDetail = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await readJson<KnowledgeProjectDetail>(response, "Project unavailable.");
    setDetail(body);
    setRename(body.project.name);
  }, []);

  const loadLibrary = useCallback(async () => {
    const [personalFiles, workspaceFiles, personalNotes, workspaceNotes] = await Promise.all([
      fetch("/api/files?scope=personal", { credentials: "same-origin", cache: "no-store" }).then(
        (r) => readJson<{ files?: KnowledgeFile[] }>(r, "Files unavailable."),
      ),
      fetch("/api/files?scope=workspace", { credentials: "same-origin", cache: "no-store" }).then(
        (r) => readJson<{ files?: KnowledgeFile[] }>(r, "Files unavailable."),
      ),
      fetch("/api/notes?scope=personal", { credentials: "same-origin", cache: "no-store" }).then(
        (r) => readJson<{ notes?: KnowledgeNote[] }>(r, "Notes unavailable."),
      ),
      fetch("/api/notes?scope=workspace", { credentials: "same-origin", cache: "no-store" }).then(
        (r) => readJson<{ notes?: KnowledgeNote[] }>(r, "Notes unavailable."),
      ),
    ]);
    setAvailableFiles([...(personalFiles.files ?? []), ...(workspaceFiles.files ?? [])]);
    setAvailableNotes([...(personalNotes.notes ?? []), ...(workspaceNotes.notes ?? [])]);
  }, []);

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
      const response = await fetch(input.url, { credentials: "same-origin", ...input });
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
      headers: { "Content-Type": "application/json" },
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

  return (
    <div className="p-4">
      <MainCard>
        <header className="mb-4">
          <h1 className="text-lg font-medium">Projects</h1>
          <p className="text-sm text-[var(--muted-foreground-2)]">
            Group files and notes into focused workspaces. Deleting a project keeps every file and
            note.
          </p>
        </header>
        <div className="mb-4 flex gap-2">
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
          <div className="border border-dashed border-[var(--border-1)] px-4 py-8 text-center text-sm">
            <h2 className="font-medium">No projects yet</h2>
            <p className="mt-1 text-[var(--muted-foreground-2)]">
              Name your first project above. A created project appears in this list.
            </p>
          </div>
        ) : null}
        {projects.length ? (
          <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
            <aside aria-label="Project list" className="border border-[var(--border-1)]">
              {projects.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex min-h-11 w-full items-center justify-between border-b border-[var(--border-1)] px-3 text-left text-sm last:border-b-0 ${item.id === selectedId ? "bg-[var(--panel)] font-medium" : "bg-transparent"}`}
                >
                  <span className="truncate">{item.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-[var(--muted-foreground-2)]">
                    {(item.fileCount ?? 0) + (item.noteCount ?? 0)}
                  </span>
                </button>
              ))}
            </aside>
            <section
              aria-label="Project detail"
              className="min-w-0 border border-[var(--border-1)] p-3"
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
                      disabled={busy || !rename.trim() || rename.trim() === project.name}
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
                      disabled={busy}
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
                  <div className="grid gap-4 xl:grid-cols-2">
                    <section aria-label="Project files">
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
                          disabled={busy || !fileChoice}
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
                              disabled={busy}
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
                    <section aria-label="Project notes">
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
                          disabled={busy || !noteChoice}
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
                              disabled={busy}
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
      </MainCard>
    </div>
  );
}
