import { useCallback, useEffect, useState, type JSX } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { LoadErrorState } from "./LoadErrorState";

interface SpaceSummary {
  id: string;
  name: string;
  template: string;
  updatedAt: number;
}

interface SpaceDetail extends SpaceSummary {
  items: Array<{ kind: string; ref: string; addedAt: number }>;
}

interface SpaceTemplate {
  id: string;
  label: string;
  description: string;
}

function spaceIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "spaces" || !parts[1]) return null;
  try {
    return decodeURIComponent(parts[1]!);
  } catch {
    return null;
  }
}

export function SpacesView(): JSX.Element {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [templates, setTemplates] = useState<SpaceTemplate[]>([]);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(() => spaceIdFromPath());
  const [detail, setDetail] = useState<SpaceDetail | null>(null);

  const loadIndex = useCallback(async () => {
    const [spacesRes, templatesRes] = await Promise.all([
      fetch("/api/spaces", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/spaces/templates", { credentials: "same-origin", cache: "no-store" }),
    ]);
    const spacesBody = await spacesRes.json() as { spaces?: SpaceSummary[]; error?: string };
    const templatesBody = await templatesRes.json() as { templates?: SpaceTemplate[] };
    if (!spacesRes.ok || !Array.isArray(spacesBody.spaces)) {
      throw new Error(spacesBody.error ?? `Spaces unavailable (${spacesRes.status}).`);
    }
    setSpaces(spacesBody.spaces);
    if (templatesRes.ok && Array.isArray(templatesBody.templates)) {
      setTemplates(templatesBody.templates);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, signal: AbortSignal) => {
    const response = await fetch(`/api/spaces/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store", signal });
    const body = await response.json() as { space?: SpaceDetail; error?: string };
    if (!response.ok || !body.space) {
      throw new Error(body.error ?? `Space unavailable (${response.status}).`);
    }
    if (!signal.aborted) setDetail(body.space);
  }, []);

  useEffect(() => {
    void loadIndex().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Spaces could not be loaded.");
    });
  }, [loadIndex]);

  useEffect(() => {
    const onPop = () => setDetailId(spaceIdFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setError(null);
    if (!detailId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    void loadDetail(detailId, controller.signal).catch((cause) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Space detail could not be loaded.");
      }
    });
    return () => controller.abort();
  }, [detailId, loadDetail]);

  const openSpace = (id: string) => {
    const path = `/spaces/${encodeURIComponent(id)}/`;
    window.history.pushState(window.history.state, "", path);
    setDetailId(id);
  };

  const createSpace = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: name.trim() || "Untitled space", template }),
      });
      const body = await response.json() as { space?: SpaceDetail; error?: string };
      if (!response.ok || !body.space) {
        throw new Error(body.error ?? `Create failed (${response.status}).`);
      }
      setName("");
      await loadIndex();
      openSpace(body.space.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Space could not be created.");
    } finally {
      setBusy(false);
    }
  };

  if (detailId && detail?.id === detailId) {
    return (
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-4">
          <button type="button" onClick={() => { window.history.pushState(window.history.state, "", "/spaces/"); setDetailId(null); }} className="text-xs text-[var(--primary)] self-start">
            ← All spaces
          </button>
          <h2 className="text-lg font-semibold">{detail.name}</h2>
          <p className="text-xs text-[var(--muted-foreground-2)]">Template: {detail.template}</p>
          <ul className="flex flex-col gap-2">
            {detail.items.length === 0 ? (
              <li className="text-xs text-[var(--muted-foreground-2)]">No items yet.</li>
            ) : detail.items.map((item) => (
              <li key={`${item.kind}:${item.ref}`} className="rounded border border-[var(--border-1)] px-3 py-2 text-xs font-mono">
                {item.kind} · {item.ref}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain bg-[var(--bg)] text-[var(--fg)]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold font-sans tracking-tight">Spaces</h2>
          <p className="text-xs text-[var(--muted-foreground-2)] mt-0.5">
            Hosted mini-apps the coworker can extend. Sharing and run scoping arrive in a later slice.
          </p>
        </div>

        {error ? <LoadErrorState message={error} onRetry={() => { setError(null); void loadIndex(); }} /> : null}

        <div className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-4 shadow-[var(--sh-card)]">
          <h3 className="text-sm font-semibold">Create Space</h3>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--muted-foreground-2)]">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--section)] px-3 py-2 text-sm" />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-[var(--muted-foreground-2)] mb-1">Template</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(templates.length > 0 ? templates : [{ id: "blank", label: "Blank", description: "Empty space" }]).map((entry) => (
                <label key={entry.id} className={`flex flex-col gap-1 rounded border px-3 py-2 text-xs cursor-pointer ${template === entry.id ? "border-[var(--primary)]/40 bg-[var(--primary-soft)]" : "border-[var(--border-1)]"}`}>
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="space-template" checked={template === entry.id} onChange={() => setTemplate(entry.id)} />
                    {entry.label}
                  </span>
                  <span className="text-[var(--muted-foreground-2)] pl-6">{entry.description}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" disabled={busy} onClick={() => void createSpace()} className="self-start bg-[var(--primary)] text-[var(--primary-text)] min-h-10 rounded-[var(--radius-button)] text-[13px] font-semibold px-4 flex items-center gap-2 disabled:opacity-50">
            <Plus aria-hidden className="size-4" />
            Create Space
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Your spaces</h3>
          {spaces.length === 0 ? (
            <p className="text-xs text-[var(--muted-foreground-2)]">No spaces yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {spaces.map((space) => (
                <li key={space.id}>
                  <button type="button" onClick={() => openSpace(space.id)} className="w-full text-left rounded border border-[var(--border-1)] px-3 py-2 text-xs flex justify-between gap-2 hover:bg-[var(--section)]">
                    <span className="font-medium">{space.name}</span>
                    <span className="text-[var(--muted-foreground-2)] flex items-center gap-1">{space.template}<ExternalLink className="size-3" /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
