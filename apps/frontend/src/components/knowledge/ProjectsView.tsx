import { useCallback, useEffect, useState, type JSX } from "react";
import type { KnowledgeProject } from "@shiba/shared";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";

export function ProjectsView(): JSX.Element {
  const [projects, setProjects] = useState<KnowledgeProject[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/projects", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { projects?: KnowledgeProject[]; error?: string };
    if (!response.ok || !Array.isArray(body.projects)) throw new Error(body.error ?? "Projects unavailable.");
    setProjects(body.projects);
  }, []);

  useEffect(() => { void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Projects failed to load.")); }, [load]);

  async function create() {
    const response = await fetch("/api/projects", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Create failed.");
    setName("");
    await load();
  }

  return (
    <div className="p-4">
      <MainCard>
        <header className="mb-3">
          <h1 className="text-lg font-medium">Projects</h1>
          <p className="text-sm text-[var(--muted-foreground-2)]">Group files and notes for a workspace.</p>
        </header>
        <div className="mb-3 flex gap-2">
          <input className="flex-1 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" aria-label="Project name" />
          <button type="button" className="rounded border border-[var(--border-1)] px-3 py-1 text-sm" onClick={() => void create().catch((err: unknown) => setError(err instanceof Error ? err.message : "Create failed."))}>Create</button>
        </div>
        {error ? <LoadErrorState message={error} onRetry={() => void load()} /> : null}
        <ul className="divide-y divide-[var(--border-1)] text-sm">
          {projects.map((project) => <li key={project.id} className="py-2 font-medium">{project.name}</li>)}
        </ul>
      </MainCard>
    </div>
  );
}
