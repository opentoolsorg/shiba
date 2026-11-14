import { useState, type FormEvent, type JSX } from "react";
import type { AskUserAnswer, AskUserRequest } from "@shiba/shared";

export interface AskUserPending {
  askId: string;
  request: AskUserRequest;
}

export interface AskUserCardProps {
  pending: AskUserPending;
  busy?: boolean;
  onSubmit: (answer: AskUserAnswer) => void | Promise<void>;
}

export function AskUserCard({ pending, busy, onSubmit }: AskUserCardProps): JSX.Element {
  const { request } = pending;
  const [freeText, setFreeText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [rememberForRoom, setRememberForRoom] = useState(true);
  const choices = "choices" in request ? request.choices.slice(0, 4) : [];
  const truncated = "choices" in request && request.choices.length > 4;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (request.mode === "free_text") {
      void onSubmit({ mode: "free_text", text: freeText.trim(), rememberForRoom });
      return;
    }
    if (request.mode === "single_choice" && (other ? freeText.trim() : selected[0])) {
      void onSubmit({
        mode: "single_choice",
        choiceId: other ? "other" : selected[0]!,
        ...(freeText.trim() ? { freeText: freeText.trim() } : {}),
        rememberForRoom,
      });
      return;
    }
    if (request.mode === "multi_choice" && selected.length > 0) {
      void onSubmit({
        mode: "multi_choice",
        choiceIds: selected,
        ...(request.allowFreeText && freeText.trim() ? { freeText: freeText.trim() } : {}),
        rememberForRoom,
      });
    }
    if (request.mode === "connect_app") {
      void onSubmit({ mode: "connect_app", connected: true, note: freeText.trim() || undefined });
    }
  };

  return (
    <form className="flex flex-col gap-3 border border-[var(--border-1)] bg-[var(--card)] p-4" onSubmit={submit}>
      <h3 className="text-sm font-medium text-[var(--fg)]">The agent needs your input</h3>
      <p className="text-sm text-[var(--ink-2)] whitespace-pre-wrap">{request.prompt}</p>
      {request.mode === "connect_app" ? (
        <a className="text-sm underline text-[var(--primary)]" href={request.app.connectUrl} target="_blank" rel="noopener noreferrer">
          {request.app.label}
        </a>
      ) : null}
      {(request.mode === "single_choice" || request.mode === "multi_choice") ? (
        <ul className="flex flex-col gap-2">
          {choices.map((choice) => (
            <li key={choice.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type={request.mode === "single_choice" ? "radio" : "checkbox"}
                  name={`ask-${request.askId}`}
                  value={choice.id}
                  checked={selected.includes(choice.id)}
                  onChange={() => {
                    if (request.mode === "single_choice") setSelected([choice.id]);
                    else setSelected((current) => current.includes(choice.id) ? current.filter((id) => id !== choice.id) : [...current, choice.id]);
                  }}
                />
                <span>
                  <span className="font-medium text-[var(--fg)]">{choice.label}</span>
                  {choice.description ? <span className="block text-[var(--muted-foreground-2)]">{choice.description}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {truncated ? <p className="text-xs text-[var(--muted-foreground-2)]">Only the first four options are shown.</p> : null}
      {(request.mode === "single_choice" || request.mode === "multi_choice") ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={`ask-${request.askId}`} checked={other} onChange={() => { setOther(true); setSelected([]); }} />
          Other
        </label>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={rememberForRoom} onChange={(event) => setRememberForRoom(event.target.checked)} />
        Remember for this room
      </label>
      {request.mode === "free_text" || request.allowFreeText ? (
        <textarea
          className="min-h-20 w-full border border-[var(--border-1)] bg-[var(--panel)] p-2 text-sm"
          value={freeText}
          placeholder={request.mode === "free_text" ? request.placeholder ?? "Your answer" : request.freeTextLabel ?? "Add details (optional)"}
          onChange={(event) => setFreeText(event.target.value)}
        />
      ) : null}
      <button type="submit" disabled={busy} className="min-h-11 border border-[var(--border-1)] px-3 text-sm font-medium disabled:opacity-50">
        Send answer
      </button>
    </form>
  );
}