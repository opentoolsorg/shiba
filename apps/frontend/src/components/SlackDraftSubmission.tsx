import { useEffect, useRef, useState } from "react";
import { SlackCoworkerClient } from "../slack-coworker-client";
import type { PersonalExecutionGrant } from "../personal-execution-client";
import { PersonalExecutionSetup } from "./PersonalExecutionSetup";

interface Props {
  workspaceId: string; actorId: string; roomId: string; draftId: string;
  text: string; agents: string[];
}
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50";

/** The parent keys this review to the native identity, room and source draft. */
export function SlackDraftSubmission({ workspaceId, actorId, roomId, draftId, text, agents }: Props) {
  const [grant, setGrant] = useState<PersonalExecutionGrant | null>(null);
  const [agent, setAgent] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState("");
  const attemptedRef = useRef(false);
  const owner = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); owner.current = controller;
    return () => { controller.abort(); owner.current = null; };
  }, []);
  const available = Boolean(grant && grant.snapshot.expiresAt > Date.now() && agents.includes(agent));
  async function submit() {
    const controller = owner.current;
    if (!controller || controller.signal.aborted || attemptedRef.current || !reviewed || !available || !grant) return;
    attemptedRef.current = true; setAttempted(true); setStatus("Submitting once…");
    try {
      const receipt = await new SlackCoworkerClient(workspaceId, actorId).submit(draftId, roomId, agent,
        { grantId: grant.snapshot.grantId, expectedVersion: grant.version }, controller.signal);
      if (controller.signal.aborted) return;
      setStatus(receipt.state === "queued"
        ? `Queued ${receipt.handoffId}. Human approval of the frozen task is still required. Open room work to review it.`
        : `Submission ${receipt.state}: ${receipt.handoffId}. Inspect room work; do not resubmit.`);
    } catch {
      if (!controller.signal.aborted) setStatus("Submission outcome unconfirmed. Inspect room work before any further action. This review will not retry.");
    }
  }
  return <section aria-label="Review Slack submission" className="mb-3 space-y-3 border border-[var(--line)] p-3 text-xs">
    <h3 className="font-semibold">Review source-fenced Slack submission</h3>
    <p>Untrusted self-authored statement. Only this draft is submitted to room {roomId}; no private thread context, selected messages or notes are imported. Installation and identity linking are not execution approval.</p>
    <blockquote className="whitespace-pre-wrap break-words">{text}</blockquote>
    <label>Slack task agent<select aria-label="Slack task agent" className={BUTTON} value={agent} disabled={attempted} onChange={event => { setAgent(event.target.value); setReviewed(false); }}>
      <option value="">Choose a room agent</option>{agents.map(id => <option key={id} value={id}>{id}</option>)}
    </select></label>
    {!attempted && <PersonalExecutionSetup workspaceId={workspaceId} actorId={actorId} selected={grant}
      onSelectionChange={value => { setGrant(value); setReviewed(false); }} />}
    <label className="block"><input type="checkbox" checked={reviewed} disabled={attempted || !available} onChange={event => setReviewed(event.target.checked)} /> I reviewed this exact statement, room, agent and personal grant. Queue for separate human approval.</label>
    <button type="button" className={BUTTON} disabled={attempted || !reviewed || !available} onClick={() => void submit()}>Submit Slack draft for approval</button>
    {status && <p role="status">{status}</p>}
  </section>;
}
