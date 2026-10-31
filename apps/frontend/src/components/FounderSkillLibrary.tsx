import { useCallback, useEffect, useState, type JSX } from "react";
import { reloadSavedSkills } from "../saved";

interface LibrarySkill {
  id: string;
  name: string;
  description: string;
  author: string;
  schedule: { label: string; cron: string; timezone: string };
  bridgeCatalogIds: string[];
  requiresSensitiveApproval: boolean;
}

export function FounderSkillLibrary(): JSX.Element {
  const [skills, setSkills] = useState<LibrarySkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/founder-skills");
      const body = await response.json().catch(() => ({})) as { skills?: LibrarySkill[]; error?: string };
      if (!response.ok) {
        setError(body.error ?? `Library could not be loaded (${response.status}).`);
        setSkills([]);
        return;
      }
      setSkills(body.skills ?? []);
    } catch {
      setError("Library could not be loaded: the backend could not be reached.");
      setSkills([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const install = async (id: string) => {
    setBusyId(`install-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/founder-skills/${encodeURIComponent(id)}/install`, { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string; skill?: { id?: string } };
      if (!response.ok) setNotice(body.error ?? `Install failed (${response.status}).`);
      else {
        setNotice(`Installed "${id}" as draft skill ${body.skill?.id ?? ""}. Review it in your skill list below.`);
        void reloadSavedSkills().catch(() => {});
      }
    } catch {
      setNotice("Install failed: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const deploy = async (id: string) => {
    setBusyId(`deploy-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/founder-skills/${encodeURIComponent(id)}/deploy`, { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setNotice(body.error ?? `Deploy failed (${response.status}).`);
      else setNotice(`Scheduled automation deployed for "${id}". Open Automations to pause or review pins.`);
    } catch {
      setNotice("Deploy failed: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-labelledby="founder-skill-library-heading" className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--section)] p-4 flex flex-col gap-3">
      <div>
        <h3 id="founder-skill-library-heading" className="text-sm font-semibold text-[var(--fg)]">Founder skill library</h3>
        <p className="text-xs text-[var(--muted-foreground-2)] mt-1">
          Viktor-style coworker skills: schedule, Slack digest, and Grok Bot bridge for SaaS connectors. Install creates a reviewed draft; deploy registers the cron automation.
        </p>
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--destructive)]">{error}</p> : null}
      {notice ? <p role="status" className="text-xs text-[var(--primary)]">{notice}</p> : null}
      {skills === null ? (
        <p className="text-xs text-[var(--muted-foreground-2)]">Loading library…</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {skills.map((skill) => (
            <li key={skill.id} className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-3 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--fg)]">{skill.name}</span>
                <span className="text-[10px] font-mono text-[var(--muted-foreground-2)] whitespace-nowrap">{skill.schedule.label}</span>
              </div>
              <p className="text-[11px] text-[var(--muted-foreground-2)] leading-relaxed flex-1">{skill.description}</p>
              {skill.bridgeCatalogIds.length ? (
                <p className="text-[10px] text-[var(--muted-foreground-3)]">Via Grok Bot: {skill.bridgeCatalogIds.join(", ")}</p>
              ) : null}
              {skill.requiresSensitiveApproval ? (
                <p className="text-[10px] text-[var(--warning-fg)]">Sensitive — Slack post waits for approval.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyId === `install-${skill.id}`}
                  onClick={() => void install(skill.id)}
                  className="text-[10px] border border-[var(--border-1)] rounded px-2 py-1 disabled:opacity-50"
                >
                  Install draft
                </button>
                <button
                  type="button"
                  disabled={busyId === `deploy-${skill.id}`}
                  onClick={() => void deploy(skill.id)}
                  className="text-[10px] border border-[var(--primary)]/30 text-[var(--primary)] rounded px-2 py-1 disabled:opacity-50"
                >
                  Deploy schedule
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
