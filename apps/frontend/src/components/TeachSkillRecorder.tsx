import { useEffect, useRef, useState } from "react";
import { saveSkill } from "../saved";

const STEPS = {
  "Read the request": ["Sample request: Summarize this week’s open support questions.", "Read the request and identify the intended outcome."],
  "Check requirements": ["Sample requirements: Group related questions and flag any blockers. Leave out customer names.", "Check the requirements and identify what must be left out."],
  "Draft the handoff": ["Sample draft: Group the open questions by topic and list blockers separately.", "Draft the handoff using the requirements and flag any blockers."],
  "Preview for review": ["Sample preview: Check for missing topics and private details before asking for review.", "Preview the handoff for completeness and private details before requesting review."],
} as const;
type Step = keyof typeof STEPS;
const STEP_NAMES = Object.keys(STEPS) as Step[];
const MAX_STEPS = 20;
const BUTTON = "min-h-11 border border-[var(--line)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] disabled:opacity-50";
const FIELD = "mt-1 w-full min-w-0 border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] disabled:opacity-50";

type Session =
  | { phase: "idle"; notice?: string }
  | { phase: "recording"; steps: Step[] }
  | { phase: "proposal"; name: string; instructions: string; reviewed: boolean };

export function TeachSkillRecorder() {
  const [session, setSession] = useState<Session>({ phase: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const recording = session.phase === "recording";

  useEffect(() => {
    if (!recording) return;
    const discardRecording = () => {
      setSession((current) => current.phase === "recording"
        ? { phase: "idle", notice: "Recording discarded when you left the page." }
        : current);
    };
    const onVisibilityChange = () => { if (document.hidden) discardRecording(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", discardRecording);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", discardRecording);
    };
  }, [recording]);

  const record = (step: Step) => {
    if (document.hidden) return;
    setSession((current) => current.phase === "recording" && current.steps.length < MAX_STEPS
      ? { phase: "recording", steps: [...current.steps, step] }
      : current);
  };
  const stop = () => {
    setSession((current) => {
      if (current.phase !== "recording" || current.steps.length === 0 || document.hidden) return current;
      return {
        phase: "proposal", name: "Review a support handoff", reviewed: false,
        instructions: current.steps.map((step, index) => `${index + 1}. ${STEPS[step][1]}`).join("\n"),
      };
    });
  };
  const save = async () => {
    if (session.phase !== "proposal" || !session.reviewed || !session.name.trim() || !session.instructions.trim() || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(false);
    try {
      await saveSkill({ name: session.name.trim(), instructions: session.instructions.trim() });
      setSession({ phase: "idle", notice: "Draft saved. Review and activate it separately in your saved skills." });
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const lastStep = session.phase === "recording" ? session.steps.at(-1) : undefined;
  return (
    <section aria-label="Teach by recording" className="grid min-w-0 gap-3 border border-[var(--line)] bg-[var(--card)] p-4 text-[var(--ink)]">
      <h3 className="text-sm font-semibold">Teach by recording</h3>
      <p className="text-xs leading-relaxed text-[var(--ink-2)]">Demonstrate a workflow with the sample support request below. Shiba records only the order of the practice buttons you choose. It never records your screen, microphone, other tabs or typed input.</p>
      {session.phase === "idle" && (
        <>
          {session.notice && <p role="status" className="text-xs">{session.notice}</p>}
          <button type="button" className={`${BUTTON} justify-self-start`} onClick={() => setSession({ phase: "recording", steps: [] })}>Start recording</button>
        </>
      )}
      {session.phase === "recording" && (
        <>
          <p role="status" className="text-xs font-semibold text-[var(--danger)]">Recording · {session.steps.length}/{MAX_STEPS} practice steps</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={session.steps.length === 0} onClick={stop}>Stop and propose draft</button>
            <button type="button" className={BUTTON} onClick={() => setSession({ phase: "idle", notice: "Recording discarded." })}>Cancel recording</button>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 border-t border-[var(--line)] pt-3 sm:grid-cols-2" role="group" aria-label="Practice actions">
            {STEP_NAMES.map((step) => <button key={step} type="button" className={`${BUTTON} text-left`} disabled={session.steps.length >= MAX_STEPS} onClick={() => record(step)}>{step}</button>)}
          </div>
          <p aria-live="polite" className="text-xs leading-relaxed text-[var(--ink-2)]">{lastStep ? STEPS[lastStep][0] : "Choose a practice action to begin. No real requests are opened or sent."}</p>
        </>
      )}
      {session.phase === "proposal" && (
        <div className="grid min-w-0 gap-3 border-t border-[var(--line)] pt-3">
          <h4 className="text-sm font-semibold">Review proposed skill</h4>
          <p className="text-xs text-[var(--ink-2)]">Nothing has been saved. Review or edit the instructions and leave out credentials and private details. Saving won’t activate or run the skill.</p>
          <label className="text-xs">Proposed skill name<input className={FIELD} value={session.name} maxLength={100} disabled={saving} onChange={(event) => setSession({ ...session, name: event.target.value, reviewed: false })} /></label>
          <label className="text-xs">Proposed instructions<textarea className={FIELD} value={session.instructions} maxLength={16000} rows={5} disabled={saving} onChange={(event) => setSession({ ...session, instructions: event.target.value, reviewed: false })} /></label>
          <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" disabled={saving} checked={session.reviewed} onChange={(event) => setSession({ ...session, reviewed: event.target.checked })} />I’ve reviewed this draft and it contains no private details.</label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={saving || !session.reviewed || !session.name.trim() || !session.instructions.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save proposed draft"}</button>
            <button type="button" className={BUTTON} disabled={saving} onClick={() => { setError(false); setSession({ phase: "idle", notice: "Proposal discarded." }); }}>Discard proposal</button>
          </div>
          {error && <p role="alert" className="text-xs text-[var(--danger)]">Couldn’t save the draft. Your proposal is still here; try again.</p>}
        </div>
      )}
    </section>
  );
}
