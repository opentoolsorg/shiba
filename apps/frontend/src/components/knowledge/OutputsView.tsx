import { useCallback, useEffect, useState, type JSX } from "react";
import { Download } from "lucide-react";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";

interface OutputItem {
  id: string;
  kind: "run-deliverable" | "output";
  title: string;
  mime: string;
  downloadPath: string;
  createdAt: number;
}

export function OutputsView(): JSX.Element {
  const [items, setItems] = useState<OutputItem[]>([]);
  const [filter, setFilter] = useState<"" | "archive" | "output">("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = filter ? `?type=${filter === "archive" ? "archive" : "output"}` : "";
    const response = await fetch(`/api/outputs${query}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { items?: OutputItem[]; error?: string };
    if (!response.ok || !Array.isArray(body.items)) throw new Error(body.error ?? `Outputs unavailable (${response.status}).`);
    setItems(body.items);
  }, [filter]);

  useEffect(() => { void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Outputs failed to load.")); }, [load]);

  return (
    <div className="p-4">
      <MainCard>
        <header className="mb-3">
          <h1 className="text-lg font-medium">Outputs</h1>
          <p className="text-sm text-[var(--muted-foreground-2)]">Run deliverables and generated media from your workspace.</p>
        </header>
        <div className="mb-3">
          <select className="border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="">All types</option>
            <option value="archive">Run deliverables</option>
            <option value="output">Generated media</option>
          </select>
        </div>
        {error ? <LoadErrorState message={error} onRetry={() => void load()} /> : null}
        <ul className="divide-y divide-[var(--border-1)] text-sm">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{item.title}</p>
                <p className="text-xs text-[var(--muted-foreground-2)]">{item.kind} · {item.mime}</p>
              </div>
              <a className="inline-flex items-center gap-1 rounded border border-[var(--border-1)] px-2 py-1 text-xs" href={item.downloadPath}>
                <Download size={12} /> Download
              </a>
            </li>
          ))}
        </ul>
      </MainCard>
    </div>
  );
}