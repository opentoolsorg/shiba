import { useEffect, useState } from "react";
import type { UiAnswer } from "@shiba/shared";
import { createCompletionDrivenPoll, documentVisibilityPause } from "../polling";
import { UiBlockCard } from "./UiBlockCard";

interface Question { runId?: string; blockId: string; block: unknown; fallbackText: string; status: "pending" | "answered" | "cancelled"; answer?: UiAnswer }

export function UiBlockQuestions({ runId, sessionId }: { runId: string; sessionId?: string }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/ui-blocks${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Questions request failed: ${response.status}`);
        const body = await response.json() as { questions?: Question[] };
        if (!controller.signal.aborted) { setQuestions(body.questions ?? []); setError(null); }
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Questions could not be loaded.");
      }
    };
    const poll = createCompletionDrivenPoll({ intervalMs: 3000, load, pause: documentVisibilityPause() });
    void load();
    return () => { controller.abort(); poll.stop(); };
  }, [runId, sessionId]);
  return <section aria-label="Interactive questions">
    {error ? <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p> : null}
    {questions.map((question) => <UiBlockCard key={`${question.runId ?? runId}:${question.blockId}`} {...question} runId={question.runId ?? runId} sessionId={sessionId} />)}
  </section>;
}
