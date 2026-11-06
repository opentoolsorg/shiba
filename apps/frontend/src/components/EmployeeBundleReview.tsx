import { useEffect, useMemo, useState, type JSX } from "react";
import {
  validateEmployeeBundle,
  type EmployeeBundle,
  type EmployeeBundleImportResult,
  type EmployeeBundlePreview,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const button = "min-h-11 border border-[var(--border-1)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2";

async function post<T>(path: string, body: unknown, workspaceId?: string): Promise<T> {
  const response = await fetch(`/api/employee-bundles/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify(body),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status}).`);
  return value;
}

/** Recipes contain prose only; preview and import never install code or activate permissions. */
export function EmployeeBundleReview({ recipe, onClose, onImported, workspaceId }: {
  recipe: EmployeeBundle; onClose: () => void; onImported: (result: EmployeeBundleImportResult) => void; workspaceId?: string;
}): JSX.Element {
  const [selected, setSelected] = useState(() => recipe.skills.map(() => true));
  const [preview, setPreview] = useState<EmployeeBundlePreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importId, setImportId] = useState("");
  const selectedRecipe = useMemo(() => ({ ...recipe, skills: recipe.skills.filter((_, index) => selected[index]) }), [recipe, selected]);
  useEffect(() => {
    let current = true;
    setPreview(null); setReviewed(false); setError("");
    void post<EmployeeBundlePreview>("preview", { recipe: selectedRecipe }, workspaceId).then((value) => {
      if (current) { setPreview(value); setImportId(crypto.randomUUID()); }
    }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : "Preview unavailable."); });
    return () => { current = false; };
  }, [selectedRecipe, workspaceId]);
  const importRecipe = async () => {
    if (!preview || !reviewed) return;
    setBusy(true); setError("");
    try {
      const result = await post<EmployeeBundleImportResult>("import", {
        previewId: preview.previewId, recipe: preview.recipe, expectedDigest: preview.digest, importId, reviewed: true,
      }, workspaceId);
      onImported(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Import failed. Retry with the same review."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Review employee bundle" className="mt-4 min-w-0 border border-[var(--border-1)] bg-[var(--card)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Review {recipe.profile.name}</h3><button type="button" className={button} disabled={busy} onClick={onClose}>Close review</button></div>
    <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">Creates a workspace-visible archived bot and personal draft skills. Restore the bot and activate selected skills only after review. No accounts are connected, permissions granted, or skills activated. Conversation history and private memory are not copied automatically. Review all included prose for private information.</p>
    <dl className="mt-3 grid gap-1 text-xs"><div><dt className="inline font-semibold">Role: </dt><dd className="inline">{recipe.profile.roleTemplateId ?? "Custom"}</dd></div><div><dt className="inline font-semibold">Requested tool: </dt><dd className="inline">{recipe.profile.harness}{recipe.profile.codingModel ? ` · ${recipe.profile.codingModel}` : ""} · configure your own provider before running</dd></div><div><dt className="inline font-semibold">Outputs: </dt><dd className="inline">{recipe.profile.expectedDeliverables.join(", ") || "Choose when creating a task"}</dd></div></dl>
    <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold">Instructions and provenance</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-[var(--border-1)] p-2 text-xs">{recipe.profile.instructions}</pre>{recipe.profile.provenance ? <p className="mt-2 break-words font-mono text-xs">{recipe.profile.provenance.kind}: {recipe.profile.provenance.id}@{recipe.profile.provenance.revision}</p> : null}</details>
    <fieldset className="mt-3"><legend className="text-xs font-semibold">Copy selected skills as drafts</legend>{recipe.skills.length ? recipe.skills.map((skill, index) => <div key={index} className="py-2 text-xs"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" disabled={busy} checked={selected[index] ?? false} onChange={(event) => setSelected((old) => old.map((value, i) => i === index ? event.target.checked : value))}/><span>{skill.name}{skill.provenance ? ` · ${skill.provenance.id}@${skill.provenance.revision}` : ""}</span></label><details><summary className="cursor-pointer py-2">Read skill instructions</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{skill.instructions}</pre></details></div>) : <p className="mt-2 text-xs">No skill bodies included.</p>}</fieldset>
    <div className="mt-3 text-xs"><h4 className="font-semibold">Unconnected recommendations</h4>{recipe.requirements.length ? <ul className="mt-1 list-inside list-disc">{recipe.requirements.map((item, index) => <li key={index}>{item.name} ({item.kind}) — {item.description}{item.configurationRequired.length ? ` Required: ${item.configurationRequired.join("; ")}.` : ""}</li>)}</ul> : <p className="mt-1">No connection requirements included.</p>}</div>
    <div className="mt-3 text-xs"><h4 className="font-semibold">Disabled routine descriptions</h4><p className="mt-1">Descriptions are retained for setup; executable schedules are not installed.</p>{recipe.routines.length ? <ul className="mt-1 list-inside list-disc">{recipe.routines.map((item, index) => <li key={index}>{item.name} — {item.description} Required: {item.configurationRequired.join("; ") || "Choose configuration"}.</li>)}</ul> : null}</div>
    {preview ? <p className="mt-3 break-all font-mono text-[10px]">Review digest: {preview.digest}</p> : !error ? <p role="status" className="mt-3 text-xs">Preparing immutable preview…</p> : null}
    <label className="mt-3 flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={reviewed} disabled={!preview || busy} onChange={(event) => setReviewed(event.target.checked)}/>I reviewed these instructions, selected skills and setup requirements.</label>
    {error ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p> : null}
    <button type="button" className={button} disabled={!preview || !reviewed || busy} onClick={() => void importRecipe()}>{busy ? "Importing reviewed bundle…" : "Import archived bot and draft skills"}</button>
  </section>;
}

export function EmployeeBundleExport({ employeeId, expectedVersion, onClose, workspaceId }: {
  employeeId: string; expectedVersion: number; onClose: () => void; workspaceId?: string;
}): JSX.Element {
  const [skills, setSkills] = useState<Array<{ id: string; version: number; name: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setSelected([]); setOutput(""); setSkills([]); setMessage("");
    void fetch("/api/skills?limit=50", { headers: teamWorkspaceHeaders(workspaceId) }).then(async (response) => {
      if (!response.ok) throw new Error("Could not load readable active skill versions.");
      const value = await response.json() as { skills?: Array<{ id: string; version: number; activeVersion?: number; status: string; name: string }> };
      if (current) setSkills((value.skills ?? []).filter((item) => item.status === "active" && item.version === item.activeVersion));
    }).catch((error: unknown) => { if (current) setMessage(error instanceof Error ? error.message : "Skills unavailable."); });
    return () => { current = false; };
  }, [workspaceId, employeeId]);
  const exportRecipe = async () => {
    setBusy(true); setMessage(""); setOutput("");
    try {
      const value = await post<{ recipe: unknown }>("export", { employeeId, expectedVersion,
        skillPins: skills.filter((skill) => selected.includes(skill.id)).map((skill) => ({ skillId: skill.id, version: skill.version })) }, workspaceId);
      setOutput(JSON.stringify(validateEmployeeBundle(value.recipe), null, 2));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Export unavailable."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Export employee bundle" className="mt-4 border border-[var(--border-1)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Export owned bot recipe</h3><button type="button" className={button} onClick={onClose}>Close export</button></div>
    <p className="mt-2 text-xs">Choose up to five currently active readable skill versions from the first 50 results. Only bots with recorded personal ownership can be exported. Review prose for private information before sharing.</p>
    {skills.map((skill) => <label key={skill.id} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={selected.includes(skill.id)} disabled={busy || (!selected.includes(skill.id) && selected.length >= 5)} onChange={(event) => { setOutput(""); setSelected((old) => event.target.checked ? [...old, skill.id] : old.filter((id) => id !== skill.id)); }}/>{skill.name} · v{skill.version}</label>)}
    <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => void exportRecipe()}>{busy ? "Exporting…" : "Prepare bundle JSON"}</button>
    {message ? <p role="status" className="mt-2 text-xs">{message}</p> : null}
    {output ? <><textarea aria-label="Exported employee bundle JSON" readOnly value={output} rows={10} className="mt-3 w-full border border-[var(--border-1)] bg-[var(--bg)] p-2 font-mono text-xs"/><button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(output).then(() => setMessage("Bundle JSON copied."), () => setMessage("Clipboard unavailable. Select and copy the JSON.")); }}>Copy bundle JSON</button></> : null}
  </section>;
}
