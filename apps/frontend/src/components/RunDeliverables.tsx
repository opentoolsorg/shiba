import { useEffect, useRef, useState, type JSX } from "react";
import type { RunDeliverable, RunStatus } from "@shiba/shared";

interface ArtifactVersion {
  runId: string;
  index: number;
  path: string;
  version: number;
  sha256: string;
  bytes: number;
  createdAt: number;
  review: { status: "pending_review" | "approved" | "changes_requested"; revision?: number; updatedAt?: number; note?: string };
  provenance?: RunDeliverable["provenance"];
}

type ReviewState = NonNullable<RunDeliverable["review"]>;
const reviewRevision = (review: ReviewState | undefined) => review?.revision ?? 0;

function artifactRoute(runId: string, index: number, action: string, sessionId?: string): string {
  const route = `/api/runs/${encodeURIComponent(runId)}/deliverables/${index}/${action}`;
  return sessionId && sessionId !== "default"
    ? `${route}?${new URLSearchParams({ session: sessionId })}`
    : route;
}

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
  const completed = status === "completed";
  return (
    <section
      aria-label="Deliverables"
      className="border-t border-[var(--border-1)] pt-3 flex flex-col gap-2"
    >
      <h4 className="text-xs font-semibold text-[var(--fg)]">Deliverables</h4>
      <p className="text-xs text-[var(--muted-foreground-2)]">
        Captured files pass presence and size checks, with JSON syntax checked when applicable.
        Review their content before using or publishing it.
      </p>
      <ul className="flex flex-col gap-2">
        {paths.map((filePath) => {
          const index = deliverables.findIndex((file) => file.path === filePath);
          const file = deliverables[index];
          const route = `/api/runs/${encodeURIComponent(runId)}/deliverables/${index}`;
          const href =
            sessionId && sessionId !== "default"
              ? `${route}?${new URLSearchParams({ session: sessionId })}`
              : route;
          return (
            <li key={filePath} className="text-xs flex flex-col gap-1 min-w-0">
              <code className="break-all text-[var(--fg)]">{filePath}</code>
              {file ? (
                <ArtifactDetails
                  key={`${file.path}:${file.sha256}`}
                  runId={runId}
                  index={index}
                  filePath={filePath}
                  file={file}
                  href={href}
                  completed={completed}
                  sessionId={sessionId}
                />
              ) : (
                <span className="text-[var(--muted-foreground-2)]">
                  {pending ? "Awaiting captured file" : "Not captured"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ArtifactDetails({
  runId,
  index,
  filePath,
  file,
  href,
  completed,
  sessionId,
}: {
  runId: string;
  index: number;
  filePath: string;
  file: RunDeliverable;
  href: string;
  completed: boolean;
  sessionId?: string;
}): JSX.Element {
  const [history, setHistory] = useState<ArtifactVersion[]>([]);
  const [reviewStatus, setReviewStatus] = useState(file.review?.status ?? "pending_review");
  const [note, setNote] = useState(file.review?.note ?? "");
  const [savedReview, setSavedReview] = useState<ReviewState | undefined>(file.review);
  const [expectedReviewRevision, setExpectedReviewRevision] = useState(reviewRevision(file.review));
  const [currentArtifactId, setCurrentArtifactId] = useState(file.artifactId);
  const [message, setMessage] = useState("");
  const [revisionCommandId, setRevisionCommandId] = useState<string | null>(null);
  const [revisionCreated, setRevisionCreated] = useState(false);
  const [saving, setSaving] = useState(false);
  const reviewAuthorityVersion = useRef(0);
  useEffect(() => {
    if (!completed) return;
    let active = true;
    const requestVersion = reviewAuthorityVersion.current;
    void fetch(artifactRoute(runId, index, "history", sessionId), {
      headers: { accept: "application/json" },
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<{ artifactId?: string; versions?: ArtifactVersion[] }>) : null,
      )
      .then((payload) => {
        if (active && payload?.versions) {
          setHistory(payload.versions);
          if (payload.artifactId) setCurrentArtifactId(payload.artifactId);
          const currentVersion = payload.versions.find((version) => version.runId === runId && version.index === index);
          if (currentVersion?.review && reviewAuthorityVersion.current === requestVersion) {
            setSavedReview(currentVersion.review);
            setExpectedReviewRevision(reviewRevision(currentVersion.review));
          }
        }
      })
      .catch(() => {
        if (active) setMessage("Version history is temporarily unavailable.");
      });
    return () => {
      active = false;
    };
  }, [completed, file.artifactId, index, runId, sessionId]);
  const saveReview = async () => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(artifactRoute(runId, index, "review", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: reviewStatus,
          expectedRevision: expectedReviewRevision,
          ...(reviewStatus === "changes_requested" && note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        currentReview?: ReviewState;
        deliverable?: { review?: ReviewState };
      };
      if (response.status === 409 && result.currentReview) {
        reviewAuthorityVersion.current += 1;
        setSavedReview(result.currentReview);
        setExpectedReviewRevision(reviewRevision(result.currentReview));
        setRevisionCreated(false);
        setRevisionCommandId(null);
        setMessage(`${result.error ?? "Review changed in another tab."} Current saved review: ${result.currentReview.status.replaceAll("_", " ")}${result.currentReview.note ? ` · ${result.currentReview.note}` : ""}. Your draft is unchanged.`);
        return;
      }
      if (!response.ok) throw new Error(result.error ?? "Could not save review.");
      const authoritative = result.deliverable?.review;
      if (!authoritative) throw new Error("Review was saved, but the server did not return its authoritative state.");
      reviewAuthorityVersion.current += 1;
      setSavedReview(authoritative);
      setExpectedReviewRevision(reviewRevision(authoritative));
      setRevisionCreated(false);
      setRevisionCommandId(null);
      setMessage(
        authoritative.status === "approved"
          ? "Approved."
          : authoritative.status === "changes_requested"
            ? "Revision requested."
            : "Review reset.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save review.");
    } finally {
      setSaving(false);
    }
  };
  const createRevisionApproval = async () => {
    const commandId = revisionCommandId ?? crypto.randomUUID();
    setRevisionCommandId(commandId);
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(artifactRoute(runId, index, "revision", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          artifactId: currentArtifactId,
          artifactVersion: file.version ?? 1,
          reviewRevision: expectedReviewRevision,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        approvalId?: string;
        currentReview?: ReviewState;
      };
      if (response.status === 409 && result.currentReview) {
        reviewAuthorityVersion.current += 1;
        setSavedReview(result.currentReview);
        setExpectedReviewRevision(reviewRevision(result.currentReview));
        setRevisionCreated(false);
        setRevisionCommandId(null);
        setMessage(`${result.error ?? "Review changed in another tab."} Current saved review: ${result.currentReview.status.replaceAll("_", " ")}${result.currentReview.note ? ` · ${result.currentReview.note}` : ""}. Your draft is unchanged.`);
        return;
      }
      if (!response.ok) throw new Error(result.error ?? "Could not create revision approval.");
      if (result.currentReview) {
        reviewAuthorityVersion.current += 1;
        setSavedReview(result.currentReview);
        setExpectedReviewRevision(reviewRevision(result.currentReview));
      }
      setRevisionCreated(true);
      setMessage(`Revision approval ${result.approvalId ?? "created"}. Review it in Approvals before work starts.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create revision approval.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <span className="text-[var(--muted-foreground-2)]">
        Captured · {file.bytes.toLocaleString()} bytes · {file.mediaType}
      </span>
      <code className="text-[10px] break-all text-[var(--muted-foreground-2)]">
        SHA-256: {file.sha256}
      </code>
      {file.version !== undefined && (
        <span className="text-[11px] text-[var(--muted-foreground-2)]">
          Version {file.version} · source run {file.sourceRunId ?? runId}
        </span>
      )}
      {file.provenance?.skills?.map((skill) => (
        <span
          key={`${skill.skillId}:${skill.version}`}
          className="text-[11px] text-[var(--muted-foreground-2)]"
        >
          Skill: {skill.name} v{skill.version}
        </span>
      ))}
      {file.provenance?.customAgent && (
        <span className="text-[11px] text-[var(--muted-foreground-2)]">
          Agent profile v{file.provenance.customAgent.version}
        </span>
      )}
      <a
        href={href}
        download={filePath.split("/").pop()}
        className="text-[var(--primary)] underline w-fit"
      >
        Download {filePath}
      </a>
      {savedReview && (
        <span className="text-[11px] text-[var(--muted-foreground-2)]">
          Current saved review: {savedReview.status.replaceAll("_", " ")}
          {savedReview.note ? ` · ${savedReview.note}` : ""}
        </span>
      )}
      {completed && (
        <div className="mt-1 flex flex-col items-start gap-1">
          <label className="text-[11px] text-[var(--muted-foreground-2)]">
            Review decision
            <select
              aria-label={`Review decision for ${filePath}`}
              className="ml-2 rounded border border-[var(--border-1)] bg-[var(--card)] px-1 py-0.5 text-[11px] text-[var(--fg)]"
              value={reviewStatus}
              onChange={(event) => setReviewStatus(event.target.value as typeof reviewStatus)}
            >
              <option value="pending_review">Pending review</option>
              <option value="approved">Approve</option>
              <option value="changes_requested">Request revision</option>
            </select>
          </label>
          {reviewStatus === "changes_requested" && (
            <textarea
              aria-label={`Revision note for ${filePath}`}
              className="w-full rounded border border-[var(--border-1)] bg-[var(--card)] p-1 text-[11px] text-[var(--fg)]"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              placeholder="What should change?"
            />
          )}
          <button
            type="button"
            className="text-[var(--primary)] underline disabled:opacity-50"
            disabled={saving || (reviewStatus === "changes_requested" && !note.trim()) || !currentArtifactId}
            onClick={() => void saveReview()}
          >
            {saving ? "Saving…" : "Save review"}
          </button>
          {savedReview?.status === "changes_requested" && (
            <button
              type="button"
              className="text-[var(--primary)] underline disabled:opacity-50"
              disabled={saving || revisionCreated || !currentArtifactId}
              onClick={() => void createRevisionApproval()}
            >
              {revisionCreated ? "Revision approval created" : "Create revision approval"}
            </button>
          )}
          {message && (
            <span role="status" className="text-[11px] text-[var(--muted-foreground-2)]">
              {message}
            </span>
          )}
        </div>
      )}
      {history.length > 1 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[var(--primary)]">
            Version history ({history.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {history.map((version) => {
              const previousRoute = `/api/runs/${encodeURIComponent(version.runId)}/deliverables/${version.index}`;
              const scopedRoute =
                sessionId && sessionId !== "default"
                  ? `${previousRoute}?${new URLSearchParams({ session: sessionId })}`
                  : previousRoute;
              return (
                <li
                  key={`${version.runId}:${version.index}`}
                  className="text-[11px] text-[var(--muted-foreground-2)]"
                >
                  v{version.version} · {version.review.status.replaceAll("_", " ")} ·{" "}
                  <a
                    className="text-[var(--primary)] underline"
                    href={scopedRoute}
                    download={version.path.split("/").pop()}
                  >
                    Download prior version
                  </a>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </>
  );
}
