import { useState } from "react";
import { validateUiAnswer, type UiAnswer, type UiBlock } from "@shiba/shared";

export interface UiBlockCardProps {
  runId: string;
  block: unknown;
  fallbackText: string;
  status?: "pending" | "answered" | "cancelled";
  answer?: UiAnswer;
  sessionId?: string;
}

const buttonClass = "min-h-9 rounded border border-[var(--border-1)] px-3 py-1 text-sm disabled:opacity-50";
const inputClass = "rounded border border-[var(--border-1)] bg-[var(--bg)] px-2 py-1 text-sm";

export function UiBlockCard(props: UiBlockCardProps) {
  const candidate = props.block as Partial<UiBlock> | null;
  if (!candidate || candidate.version !== 1 || !["confirm", "quick_replies", "choice", "form"].includes(candidate.type ?? "")) {
    return <pre className="whitespace-pre-wrap text-sm">{props.fallbackText}</pre>;
  }
  return <KnownUiBlockCard key={`${props.runId}:${candidate.id}`} {...props} block={candidate as UiBlock} />;
}

function answerText(block: UiBlock, answer: UiAnswer): string {
  if (block.type === "confirm") return answer.confirmed ? block.confirmLabel : block.cancelLabel;
  if (block.type === "form") return block.fields.filter((field) => answer.values?.[field.id] !== undefined).map((field) => `${field.label}: ${String(answer.values?.[field.id])}`).join("; ");
  return block.options.filter((option) => answer.optionIds?.includes(option.id)).map((option) => option.label).join(", ");
}

function KnownUiBlockCard({ runId, block, fallbackText, status = "pending", answer, sessionId }: UiBlockCardProps & { block: UiBlock }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [staged, setStaged] = useState<UiAnswer | null>(null);
  const [submitted, setSubmitted] = useState<UiAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorded = answer ?? submitted;
  const disabled = busy || status !== "pending" || Boolean(recorded);

  async function submit(input: UiAnswer) {
    setBusy(true);
    setError(null);
    try {
      const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/ui-blocks/${encodeURIComponent(block.id)}/answer${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      const body = await response.json() as { error?: string; errors?: string[] };
      if (!response.ok) throw new Error(body.errors?.join(", ") || body.error || `Answer request failed: ${response.status}`);
      setSubmitted(input);
      setStaged(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Answer could not be submitted."); }
    finally { setBusy(false); }
  }

  function choose(input: UiAnswer) {
    if (block.type === "form" && input.values) {
      input = { ...input, values: Object.fromEntries(Object.entries(input.values).filter(([id, value]) =>
        value !== "" || !block.fields.some((field) => field.id === id && field.kind === "select" && !field.required),
      )) };
    }
    const danger = block.type === "confirm" ? Boolean(block.danger && input.confirmed)
      : block.type === "form" ? block.fields.some((field) => field.kind === "select" && field.options.some((option) => option.danger && input.values?.[field.id] === option.id))
        : block.options.some((option) => option.danger && input.optionIds?.includes(option.id));
    const checked = validateUiAnswer(block, danger ? { ...input, confirmed: true } : input);
    if (!checked.ok) { setError(checked.errors.join(", ")); return; }
    setError(null);
    if (danger) setStaged({ ...input, confirmed: true });
    else void submit(input);
  }

  const validChoice = block.type !== "choice" || (selected.length >= (block.minSelections ?? 1) && selected.length <= (block.maxSelections ?? (block.multiple ? block.options.length : 1)));
  return (
    <section aria-label="Question" className="my-3 rounded border border-[var(--border-1)] bg-[var(--panel)] p-4 text-[var(--fg)]">
      {block.title ? <h3 className="font-semibold">{block.title}</h3> : null}
      <p className="mb-3 whitespace-pre-wrap text-sm">{block.prompt}</p>
      <fieldset disabled={disabled || Boolean(staged)} className="flex flex-col gap-3">
        {block.type === "confirm" ? <div className="flex gap-2">
          <button className={buttonClass} type="button" onClick={() => choose({ blockId: block.id, confirmed: true })}>{block.confirmLabel}</button>
          <button className={buttonClass} type="button" onClick={() => choose({ blockId: block.id, confirmed: false })}>{block.cancelLabel}</button>
        </div> : null}
        {block.type === "quick_replies" ? <div className="flex flex-wrap gap-2">{block.options.map((option) => <button key={option.id} className={buttonClass} type="button" onClick={() => choose({ blockId: block.id, optionIds: [option.id] })}>{option.label}{option.danger ? " (destructive)" : ""}</button>)}</div> : null}
        {block.type === "choice" ? <>
          <p className="text-xs">Choose {block.minSelections ?? 1}–{block.maxSelections ?? (block.multiple ? block.options.length : 1)}.</p>
          {block.options.map((option) => <label key={option.id} className="flex items-start gap-2 text-sm">
            <input type={block.multiple ? "checkbox" : "radio"} name={`${runId}:${block.id}`} checked={selected.includes(option.id)}
              disabled={Boolean(block.multiple && !selected.includes(option.id) && selected.length >= (block.maxSelections ?? block.options.length))}
              onChange={() => { setStaged(null); setSelected(block.multiple ? selected.includes(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id] : [option.id]); }} />
            <span>{option.label}{option.danger ? " (destructive)" : ""}{option.description ? <span className="block text-xs">{option.description}</span> : null}</span>
          </label>)}
          <button className={buttonClass} type="button" disabled={!validChoice} onClick={() => choose({ blockId: block.id, optionIds: selected })}>Submit answer</button>
        </> : null}
        {block.type === "form" ? <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); choose({ blockId: block.id, values }); }}>
          {block.fields.map((field) => <label key={field.id} className="flex flex-col gap-1 text-sm">
            <span>{field.label}{field.required ? " (required)" : ""}</span>
            {field.kind === "checkbox" ? <input type="checkbox" required={field.required} checked={values[field.id] === true} onChange={(event) => setValues({ ...values, [field.id]: event.target.checked })} />
              : field.kind === "select" ? <select className={inputClass} required={field.required} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}>
                <option value="">Choose…</option>{field.options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.danger ? " (destructive)" : ""}</option>)}
              </select>
                : field.kind === "textarea" ? <textarea className={inputClass} required={field.required} placeholder={field.placeholder} maxLength={field.maxLength} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} />
                  : <input className={inputClass} type="text" required={field.required} placeholder={field.placeholder} maxLength={field.maxLength} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} />}
          </label>)}
          <button className={buttonClass} type="submit">{block.submitLabel}</button>
        </form> : null}
      </fieldset>
      {staged && !disabled ? <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Destructive confirmation">
        <p>This is destructive — confirm?</p>
        <button className={buttonClass} type="button" onClick={() => void submit(staged)}>Confirm destructive answer</button>
        <button className={buttonClass} type="button" onClick={() => setStaged(null)}>Go back</button>
      </div> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-[var(--destructive)]">{error}</p> : null}
      {recorded ? <p role="status" className="mt-3 whitespace-pre-wrap text-sm">Answered: {answerText(block, recorded)}</p> : status === "cancelled" ? <p role="status">Question cancelled.</p> : status === "answered" ? <p role="status">Answer recorded.</p> : null}
      <details className="mt-3 text-xs"><summary>Plain-text question</summary><pre className="whitespace-pre-wrap">{fallbackText}</pre></details>
    </section>
  );
}
