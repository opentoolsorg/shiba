import { useEffect, useState } from "react";

export function DeliverablePublication({ endpoint, sha256 }: { endpoint: string; sha256: string }) {
  const [path, setPath] = useState<string | null | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) {
          const result = await response.json() as { path: string | null };
          if (!controller.signal.aborted) setPath(result.path);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [endpoint]);

  async function update(method: "POST" | "DELETE") {
    setBusy(true);
    setMessage("");
    try {
      const match = method === "POST" ? sha256 : path?.split("/").pop();
      const response = await fetch(endpoint, { method, headers: { "If-Match": `"${match}"` } });
      const result = await response.json() as { path: string | null; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not update the published link.");
      setPath(result.path);
      setConfirm(false);
      setMessage(method === "POST" ? "This version is published." : "Public link revoked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update the published link.");
    } finally {
      setBusy(false);
    }
  }

  if (path === undefined) return null;
  const buttonClass = "min-h-11 text-[var(--primary)] underline disabled:opacity-50";
  return (
    <div className="flex flex-col items-start text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3">
        {path ? (
          <>
            <a className="inline-flex min-h-11 items-center text-[var(--primary)] underline" href={path} target="_blank" rel="noopener noreferrer">Open public link</a>
            <button type="button" className={buttonClass} onClick={async () => {
              try {
                await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
                setMessage("Public link copied.");
              } catch {
                setMessage("Could not copy the link. Open it to copy its address.");
              }
            }}>Copy public link</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void update("DELETE")}>Revoke public link</button>
          </>
        ) : confirm ? (
          <>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void update("POST")}>Publish public link</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className={buttonClass} onClick={() => setConfirm(true)}>Publish version…</button>
        )}
      </div>
      {confirm && <p>Anyone with the link can view this version until you revoke it. HTML is published without scripts.</p>}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
