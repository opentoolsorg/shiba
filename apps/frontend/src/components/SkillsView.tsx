/**
 * Skills — your saved skill library.
 *
 * A skill is a named instruction bundle an agent can carry into a run
 * (a repo of SKILL.md files, a prompt pack, a house style). Add one here,
 * then pick it in the task composer — it ships with the run to whichever
 * cloud agent executes it.
 */
import { useState, type JSX } from "react";
import { useSavedSkills, saveSkill, removeSkill } from "../saved";

const FIELD =
  "bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60 transition-colors";

export function SkillsView(): JSX.Element {
  const skills = useSavedSkills();
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addSkill = () => {
    const cleanName = name.trim();
    const cleanRepo = repoUrl.trim();
    if (!cleanName) {
      setError("Give the skill a name first.");
      return;
    }
    if (cleanRepo && !cleanRepo.startsWith("https://github.com/")) {
      setError("Skill repo must be a GitHub URL like https://github.com/owner/repo.");
      return;
    }
    saveSkill({
      name: cleanName,
      repoUrl: cleanRepo || undefined,
      notes: notes.trim() || undefined,
    });
    setName("");
    setRepoUrl("");
    setNotes("");
    setError(null);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0">
        <h2 className="text-base font-semibold text-[var(--fg)]">Skills</h2>
        <p className="text-xs text-[var(--muted-foreground-2)]">
          Saved instruction bundles your agents can use on any run. Pick them in the task composer — they ship with the run to the cloud agent.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">
          <div className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-2.5 shadow-[var(--sh-overlay)]">
            <div className="text-xs font-semibold text-[var(--fg)]">Add a skill</div>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Skill name — e.g. PR review checklist"
              aria-label="Skill name"
              className={`${FIELD} w-full`}
            />
            <input
              type="url"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="Optional GitHub repo — https://github.com/owner/repo"
              aria-label="Skill repository"
              className={`${FIELD} w-full font-mono`}
            />
            <input
              type="text"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional note — what this skill does"
              aria-label="Skill notes"
              className={`${FIELD} w-full`}
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={addSkill}
                className="text-[11px] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)] border border-[var(--primary)]/15 text-[var(--primary)] font-medium py-1.5 px-3 rounded-[var(--radius-button)] transition-colors"
              >
                Save skill
              </button>
              {error ? <span className="text-[11px] text-[var(--destructive)]">{error}</span> : null}
            </div>
          </div>

          {skills.length === 0 ? (
            <div className="rounded-[var(--radius-button)] border border-dashed border-[var(--border-2)] bg-[#f9f8f2] p-6 text-center text-xs text-[var(--muted-foreground-2)]">
              No skills saved yet — add one above, or open the task composer to pick skills when you run a task.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] px-4 py-3 flex items-start justify-between gap-3 shadow-[var(--sh-card)]"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--fg)]">{skill.name}</div>
                    {skill.repoUrl ? (
                      <div className="text-[11px] font-mono text-[var(--muted-foreground-2)] truncate">{skill.repoUrl}</div>
                    ) : null}
                    {skill.notes ? (
                      <div className="text-[11px] text-[var(--muted-foreground-2)] mt-0.5">{skill.notes}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSkill(skill.id)}
                    aria-label={`Remove ${skill.name}`}
                    className="shrink-0 text-[11px] bg-transparent hover:bg-[var(--destructive-soft)] border border-[var(--border-1)] hover:border-[var(--destructive)]/50 text-[var(--muted-foreground-2)] hover:text-[var(--destructive)] font-medium py-1 px-2.5 rounded-[var(--radius-button)] transition-colors"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
