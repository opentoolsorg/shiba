import type { JSX } from "react";
import type { RunDeliverable, RunStatus } from "@shiba/shared";

/** Only server-retained, explicitly requested files are offered for download. */
export function RunDeliverables({
  runId,
  status,
  expected = [],
  deliverables = [],
  sessionId,
}: {
  runId: string;
  status: RunStatus;
  expected?: readonly string[];
  deliverables?: readonly RunDeliverable[];
  sessionId?: string;
}): JSX.Element | null {
  const paths = expected.length > 0 ? expected : deliverables.map((file) => file.path);
  if (paths.length === 0) return null;
  const pending = status === "pending" || status === "running";
  return (
    <section aria-label="Deliverables" className="border-t border-[var(--border-1)] pt-3 flex flex-col gap-2">
      <h4 className="text-xs font-semibold text-[var(--fg)]">Deliverables</h4>
      <p className="text-xs text-[var(--muted-foreground-2)]">
        Captured files pass presence and size checks, with JSON syntax checked when applicable. Review their content before using or publishing it.
      </p>
      <ul className="flex flex-col gap-2">
        {paths.map((filePath) => {
          const index = deliverables.findIndex((file) => file.path === filePath);
          const file = deliverables[index];
          const route = `/api/runs/${encodeURIComponent(runId)}/deliverables/${index}`;
          const href = sessionId && sessionId !== "default"
            ? `${route}?${new URLSearchParams({ session: sessionId })}`
            : route;
          return (
            <li key={filePath} className="text-xs flex flex-col gap-1 min-w-0">
              <code className="break-all text-[var(--fg)]">{filePath}</code>
              {file ? (
                <>
                  <span className="text-[var(--muted-foreground-2)]">Captured · {file.bytes.toLocaleString()} bytes · {file.mediaType}</span>
                  <code className="text-[10px] break-all text-[var(--muted-foreground-2)]">SHA-256: {file.sha256}</code>
                  <a href={href} download={filePath.split("/").pop()} className="text-[var(--primary)] underline w-fit">
                    Download {filePath}
                  </a>
                </>
              ) : (
                <span className="text-[var(--muted-foreground-2)]">{pending ? "Awaiting captured file" : "Not captured"}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
