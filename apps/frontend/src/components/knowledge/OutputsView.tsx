import { useCallback, useEffect, useRef, useState, type JSX, type FormEvent } from "react";
import { Download, FileArchive, MessageSquare } from "lucide-react";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";
import { VideoArtifactPlayer } from "../VideoArtifactPlayer";

interface OutputItem {
  id: string;
  kind: "run-deliverable" | "output";
  title: string;
  mime: string;
  downloadPath: string;
  createdAt: number;
  media?: { kind: "image" | "video"; mode: string; label: string; prompt: string; aspectRatio: string; durationSeconds?: number; width?: number; height?: number };
}

interface MediaOptions { imageModels: Array<{ id: string; label: string; supportsDimensions: boolean }>; imageAspectRatios: string[]; video?: { enabled: boolean; reason?: string | null; aspectRatios: string[] } }
const modeLabels: Record<string, string> = { "text-to-image": "Created from a description", "text-to-video": "Created from a description", "image-to-video": "Animated from an image", "reference-to-video": "Made with reference images", "motion-control": "Motion copied from a video", "video-editing": "Edited from a video" };
const shapeLabels: Record<string, string> = { "1:1": "Square", "16:9": "Wide", "9:16": "Tall", "4:3": "Landscape", "3:4": "Portrait" };

export function OutputsView(): JSX.Element {
  const [items, setItems] = useState<OutputItem[]>([]);
  const [filter, setFilter] = useState<"" | "archive" | "image" | "video">("");
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<MediaOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [videoShape, setVideoShape] = useState("16:9");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setError(null);
    setLoading(true);
    const query = filter ? `?type=${filter}` : "";
    try {
      const response = await fetch(`/api/outputs${query}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as { items?: OutputItem[]; error?: string };
      if (!response.ok || !Array.isArray(body.items)) throw new Error(body.error ?? `Outputs unavailable (${response.status}).`);
      if (id === requestId.current) setItems(body.items);
    } finally { if (id === requestId.current) setLoading(false); }
  }, [filter]);

  useEffect(() => { void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Outputs failed to load.")); }, [load]);
  useEffect(() => {
    let active = true;
    void fetch("/api/outputs/media-options", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Image creation options are unavailable.");
      const body = await response.json() as MediaOptions;
      if (active) setOptions(body);
    }).catch(() => { if (active) { setOptions(null); setOptionsFailed(true); } });
    return () => { active = false; };
  }, []);

  const videoEnabled = options?.video?.enabled === true;
  const videoShapes = options?.video?.aspectRatios.length ? options.video.aspectRatios : ["16:9"];
  const shape = videoShapes.includes(videoShape) ? videoShape : videoShapes[0];
  const videoReason = optionsFailed ? "Video options could not be loaded. Refresh the page to try again." : options?.video?.reason ?? "Video creation is not available in this workspace.";

  async function createImage(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/outputs/images", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, ...(model ? { model } : {}), aspectRatio }) });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Your image could not be created. Please try again.");
      setPrompt("");
      if (filter && filter !== "image") setFilter("image"); else await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Your image could not be created."); }
    finally { setBusy(false); }
  }

  return (
    <div className="p-4">
      <MainCard>
        <header className="mb-3">
          <h1 className="text-lg font-medium">Outputs</h1>
          <p className="text-sm text-[var(--muted-foreground-2)]">Run deliverables and generated media from your workspace.</p>
        </header>
        {!!options?.imageModels.length && <form onSubmit={(event) => void createImage(event)} className="mb-6 space-y-3 border border-[var(--border-1)] p-4">
          <h2 className="font-medium">Create an image</h2>
          <label className="block text-sm">Describe your image
            <textarea required maxLength={2000} value={prompt} onChange={(event) => setPrompt(event.target.value)} className="mt-1 block min-h-24 w-full border border-[var(--border-1)] bg-[var(--card)] p-2" placeholder="A quiet coastal town at sunrise…" />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Style<select value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 block min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-3">
              <option value="">Choose for me</option>
              {options.imageModels.filter((item) => aspectRatio === "1:1" || item.supportsDimensions).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>
            <label className="text-sm">Shape<select value={aspectRatio} onChange={(event) => { setAspectRatio(event.target.value); if (event.target.value !== "1:1" && options.imageModels.some((item) => item.id === model && !item.supportsDimensions)) setModel(""); }} className="mt-1 block min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-3">
              {options.imageAspectRatios.map((shape) => <option key={shape} value={shape}>{shapeLabels[shape] ?? "Custom"} · {shape}</option>)}
            </select></label>
            <button type="submit" disabled={busy || !prompt.trim()} className="min-h-11 border border-[var(--border-1)] bg-[var(--inverse)] px-4 text-sm text-[var(--inverse-text)] disabled:opacity-50">{busy ? "Creating your image…" : "Create image"}</button>
          </div>
        </form>}
        {(options || optionsFailed) && <section aria-labelledby="outputs-video-heading" className="mb-6 flex flex-col gap-3 border border-[var(--border-1)] p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 id="outputs-video-heading" className="font-medium">Create a video</h2>
            {videoEnabled
              ? <p className="mt-1 text-sm text-[var(--muted-foreground-2)]">Videos are made in Chat. You can edit the description there, and nothing is generated until you approve it.</p>
              : <p id="outputs-video-reason" className="mt-1 text-sm text-[var(--muted-foreground-2)]">{videoReason}</p>}
          </div>
          {videoEnabled ? <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Video shape<select value={shape} onChange={(event) => setVideoShape(event.target.value)} className="mt-1 block min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-3">
              {videoShapes.map((shape) => <option key={shape} value={shape}>{shapeLabels[shape] ?? "Custom"} · {shape}</option>)}
            </select></label>
            <a href={`/threads/?${new URLSearchParams({ prompt: `Create a ${shape} video of ` })}`} className="inline-flex min-h-11 items-center gap-2 border border-[var(--border-1)] bg-[var(--inverse)] px-4 text-sm text-[var(--inverse-text)]">
              <MessageSquare aria-hidden="true" size={14} /> Create in Chat
            </a>
          </div> : <button type="button" disabled aria-describedby="outputs-video-reason" className="inline-flex min-h-11 shrink-0 items-center gap-2 self-start border border-[var(--border-1)] px-4 text-sm opacity-50 sm:self-auto">
            <MessageSquare aria-hidden="true" size={14} /> Create in Chat
          </button>}
        </section>}
        <nav aria-label="Output types" className="mb-4 flex flex-wrap gap-2">
          {([["", "All"], ["image", "Images"], ["video", "Videos"], ["archive", "Run deliverables"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`min-h-11 border border-[var(--border-1)] px-3 text-sm ${filter === value ? "bg-[var(--panel-2)] font-medium" : "bg-[var(--card)]"}`}>{label}</button>)}
        </nav>
        {error ? <LoadErrorState message={error} onRetry={() => void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Outputs failed to load."))} /> : null}
        {loading ? <p role="status" className="py-6 text-sm">Loading outputs…</p> : !items.length && !error ? <div className="border border-dashed border-[var(--border-1)] px-4 py-12 text-center"><h2 className="font-medium">No outputs yet</h2><p className="mt-2 text-sm text-[var(--muted-foreground-2)]">Create an image or finish a task to see your work here.</p></div> : null}
        <ul className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-col border border-[var(--border-1)] bg-[var(--card)]">
              <div className="flex min-h-40 items-center justify-center border-b border-[var(--border-1)] bg-[var(--panel-2)]">
                {item.mime.startsWith("image/") ? <img src={item.downloadPath} alt={item.media?.prompt ?? item.title} loading="lazy" className="aspect-video w-full object-contain" /> : item.mime === "video/mp4" ? <VideoArtifactPlayer src={item.downloadPath} title={item.title} /> : <FileArchive aria-hidden="true" size={32} className="text-[var(--muted-foreground-2)]" />}
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <p className="truncate font-medium">{item.title}</p>
                <p className="text-xs text-[var(--muted-foreground-2)]">{item.media ? [`Made with ${item.media.label}`, item.media.aspectRatio, item.media.durationSeconds ? `${item.media.durationSeconds} sec` : null, modeLabels[item.media.mode]].filter(Boolean).join(" · ") : item.kind === "run-deliverable" ? "Run deliverable" : item.mime.startsWith("image/") ? "Image" : "Video"}</p>
                {item.media?.prompt && <details><summary className="cursor-pointer truncate" title="Expand description">{item.media.prompt}</summary><p className="mt-2 whitespace-pre-wrap break-words">{item.media.prompt}</p></details>}
                <time dateTime={new Date(item.createdAt).toISOString()} className="text-xs text-[var(--muted-foreground-2)]">{new Date(item.createdAt).toLocaleDateString()}</time>
              <a download className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 border border-[var(--border-1)] px-3 text-xs" href={item.downloadPath}>
                <Download size={12} /> Download
              </a>
              </div>
            </li>
          ))}
        </ul>
      </MainCard>
    </div>
  );
}
