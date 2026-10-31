import { useEffect, useRef, useState } from "react";
import { z } from "zod";

const reviewSchema = z.object({
  status: z.enum(["pending_review", "approved", "changes_requested"]),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nonnegative(),
  note: z.string().optional(),
});
const draftSchema = z.object({
  id: z.string().regex(/^draft_[a-f0-9]{64}$/),
  employeeId: z.string(),
  employeeVersion: z.number().int().positive(),
  deliverable: z.object({
    path: z.string().min(1), mediaType: z.string(), bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.number().int().positive(),
    review: reviewSchema,
  }),
  source: z.object({
    id: z.string(), tool: z.union([z.literal("gmail_read"), z.literal("selected_context"), z.string().regex(/^ext_[a-f0-9]{12}_[a-f0-9]{16}$/)]), toolVersion: z.number().int().positive(),
    sourceMessageIds: z.array(z.string()), resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
    untrusted: z.literal(true),
    external: z.object({ schemaVersion: z.string().regex(/^[a-f0-9]{64}$/), resourceArgument: z.string(), resourceIds: z.array(z.string()) }).optional(),
  }),
});
type Draft = z.infer<typeof draftSchema>;
type Review = z.infer<typeof reviewSchema>;
const labels = { pending_review: "Pending review", approved: "Approved", changes_requested: "Changes requested" };

function draftLinks(output: unknown) {
  const parsed = z.object({
    draft: z.object({ id: z.string().regex(/^draft_[a-f0-9]{64}$/) }),
    metadataUrl: z.string(), downloadUrl: z.string(), reviewUrl: z.string(),
  }).safeParse(output);
  if (!parsed.success) return null;
  const value = parsed.data;
  const path = `/api/employee-drafts/${value.draft.id}`;
  const query = value.metadataUrl.slice(path.length);
  if (query !== "" && !/^\?session=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(query)) return null;
  if (value.metadataUrl !== `${path}${query}` || value.downloadUrl !== `${path}/download${query}` || value.reviewUrl !== `${path}/review${query}`) return null;
  return { id: value.draft.id, metadataUrl: value.metadataUrl, downloadUrl: value.downloadUrl, reviewUrl: value.reviewUrl };
}

/** Tool output locates the draft; only authenticated server state can establish its review. */
export function RetainedDraftCard({ output }: { output: unknown }) {
  const links = draftLinks(output);
  if (!links) return <p role="alert">Draft links are invalid. Reload this conversation to try again.</p>;
  return <DraftReview key={links.metadataUrl} {...links} />;
}

function DraftReview({ id, metadataUrl, downloadUrl, reviewUrl }: NonNullable<ReturnType<typeof draftLinks>>) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [decision, setDecision] = useState<Review["status"]>("pending_review");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(metadataUrl, { headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Draft could not be loaded. Reload to try again.");
        const current = z.object({ draft: draftSchema }).parse(await response.json()).draft;
        if (current.id !== id) throw new Error("Draft identity changed. Reload to try again.");
        if (!controller.signal.aborted) {
          setDraft(current);
          setDecision(current.deliverable.review.status);
          setNote(current.deliverable.review.note ?? "");
        }
      } catch {
        if (!controller.signal.aborted) setError("Draft could not be loaded. Reload to try again.");
      }
    })();
    return () => { active.current = false; controller.abort(); };
  }, [id, metadataUrl]);

  async function saveReview() {
    if (!draft || savingRef.current) return;
    if (decision === "changes_requested" && !note.trim()) {
      setError("Add a review note before requesting changes.");
      setMessage("");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(reviewUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: decision, expectedRevision: draft.deliverable.review.revision, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const payload = await response.json();
      if (!active.current) return;
      if (response.status === 409) {
        const currentReview = z.object({ currentReview: reviewSchema }).parse(payload).currentReview;
        setDraft({ ...draft, deliverable: { ...draft.deliverable, review: currentReview } });
        setMessage("Review changed in another tab. Current saved review refreshed; your decision and note are unchanged. Review again before saving.");
        return;
      }
      if (!response.ok) throw new Error("Review could not be saved. Your decision and note are unchanged.");
      const updated = z.object({ draft: draftSchema }).parse(payload).draft;
      if (updated.id !== id || updated.deliverable.sha256 !== draft.deliverable.sha256 || updated.deliverable.path !== draft.deliverable.path || updated.deliverable.version !== draft.deliverable.version) throw new Error("Draft version changed. Reload before reviewing.");
      setDraft(updated);
      setMessage("Review saved. This internal draft has not been sent.");
    } catch {
      if (active.current) setError("Review could not be saved. Your decision and note are unchanged. Reload to check saved status.");
    } finally {
      savingRef.current = false;
      if (active.current) setSaving(false);
    }
  }

  const file = draft?.deliverable;
  return (
    <section aria-label="Retained internal draft" className="bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] p-4 flex flex-col gap-2 text-sm min-w-0">
      <h3 className="font-semibold">Internal draft</h3>
      <p className="text-xs text-[var(--muted-foreground-2)]">Review content before use. Saving a review does not send email.</p>
      {!file || !draft ? <p role="status">{error ? "Draft unavailable." : "Loading saved draft…"}</p> : <>
        <code className="break-all">{file.path}</code>
        <p>Version {file.version} · {file.bytes} bytes · {file.mediaType}</p>
        <p className="break-all text-xs font-mono">SHA-256: {file.sha256}</p>
        <p className="text-xs">Employee: {draft.employeeId} v{draft.employeeVersion}</p>
        <details className="text-xs">
          <summary>Source provenance ({draft.source.tool === "gmail_read" ? "untrusted email" : draft.source.tool === "selected_context" ? "untrusted supplied facts and selected sources" : "untrusted reviewed MCP output"})</summary>
          <p>Read: {draft.source.tool} v{draft.source.toolVersion}</p>
          <p className="break-all">Receipt: {draft.source.id}</p>
          {draft.source.tool === "gmail_read" ? <p className="break-all">Messages: {draft.source.sourceMessageIds.join(", ")}</p> : null}
          {draft.source.external ? <><p className="break-all">Resources ({draft.source.external.resourceArgument}): {draft.source.external.resourceIds.join(", ")}</p><p className="break-all">Reviewed schema: {draft.source.external.schemaVersion}</p></> : null}
          <p className="break-all font-mono">Source SHA-256: {draft.source.resultSha256}</p>
        </details>
        <a href={downloadUrl} download={file.path.split("/").pop()} className="underline">Download {file.path}</a>
        <p role="status">Saved review: {labels[file.review.status]} · revision {file.review.revision}{file.review.note ? ` · ${file.review.note}` : ""}</p>
        <label className="flex flex-col gap-1">Review decision
          <select value={decision} onChange={(event) => setDecision(event.target.value as Review["status"])} disabled={saving} className="bg-[var(--card)] border border-[var(--border-1)] rounded p-2">
            <option value="pending_review">Pending review</option>
            <option value="approved">Approve</option>
            <option value="changes_requested">Request changes</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Review note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} disabled={saving} maxLength={500} className="bg-[var(--card)] border border-[var(--border-1)] rounded p-2" />
        </label>
        <button type="button" onClick={() => void saveReview()} disabled={saving} className="self-start border border-[var(--border-1)] rounded px-3 py-2">{saving ? "Saving review…" : "Save review"}</button>
      </>}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
