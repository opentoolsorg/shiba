import { useCallback, useEffect, useState, type JSX } from "react";
import { installLibrarySkill as installLibrarySkillApi, uninstallLibrarySkill, type LibrarySkillCard, fetchSkillLibrary, reloadSavedSkills } from "../saved";
import { useSavedSkills, type SavedSkill } from "../saved";
import { LoadErrorState } from "./LoadErrorState";

type Tab = "library" | "installed";

export function SkillLibraryCards(): JSX.Element {
  const [tab, setTab] = useState<Tab>("library");
  const [library, setLibrary] = useState<LibrarySkillCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const savedSkills = useSavedSkills();

  const reloadLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLibrary(await fetchSkillLibrary());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Library could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadLibrary();
  }, [reloadLibrary]);

  const install = async (slug: string) => {
    setBusySlug(slug);
    setError(null);
    try {
      await installLibrarySkillApi(slug);
      await reloadLibrary();
      await reloadSavedSkills();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Install failed.");
    } finally {
      setBusySlug(null);
    }
  };

  const uninstall = async (slug: string) => {
    setBusySlug(slug);
    setError(null);
    try {
      await uninstallLibrarySkill(slug);
      await reloadLibrary();
      await reloadSavedSkills();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Uninstall failed.");
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="skill-library-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="skill-library-heading" className="text-sm font-semibold text-[var(--fg)]">
            Skill library
          </h3>
          <p className="text-xs text-[var(--muted-foreground-2)] mt-0.5">
            Curated templates install as drafts — review and activate before runs use them.
          </p>
        </div>
        <div className="flex rounded-[var(--radius-button)] border border-[var(--border-1)] p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setTab("library")}
            className={`px-2.5 py-1 rounded-[var(--radius-button)] ${tab === "library" ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-2)]"}`}
          >
            Library
          </button>
          <button
            type="button"
            onClick={() => setTab("installed")}
            className={`px-2.5 py-1 rounded-[var(--radius-button)] ${tab === "installed" ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-2)]"}`}
          >
            Installed
          </button>
        </div>
      </div>

      {error ? <LoadErrorState message={error} onRetry={() => void reloadLibrary()} /> : null}

      {tab === "library" ? (
        loading && library.length === 0 ? (
          <p role="status" className="text-xs text-[var(--muted-foreground-2)]">Loading library…</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {library.map((skill) => (
              <LibraryCard key={skill.slug} skill={skill} busy={busySlug === skill.slug} onInstall={install} onUninstall={uninstall} />
            ))}
          </ul>
        )
      ) : (
        <InstalledSkillsList skills={savedSkills.skills.filter((skill) => skill.status !== "disabled")} loading={savedSkills.loading} />
      )}
    </section>
  );
}

function LibraryCard({
  skill,
  busy,
  onInstall,
  onUninstall,
}: {
  skill: LibrarySkillCard;
  busy: boolean;
  onInstall: (slug: string) => void;
  onUninstall: (slug: string) => void;
}): JSX.Element {
  return (
    <li className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-2 shadow-[var(--sh-card)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-[var(--fg)]">{skill.name}</div>
          <div className="text-[10px] text-[var(--muted-foreground-2)]">v{skill.version}</div>
        </div>
        {skill.installed ? (
          <div className="flex flex-col items-end gap-1">
            <span className="text-[10px] rounded-full border border-[var(--primary)]/30 text-[var(--primary)] px-2 py-0.5">Installed</span>
            {skill.updateAvailable ? (
              <span className="text-[9px] text-[var(--warning-fg)]">Update available</span>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void onUninstall(skill.slug)} className="text-[10px] underline disabled:opacity-50">
              Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onInstall(skill.slug)}
            className="text-[10px] border border-[var(--primary)]/30 text-[var(--primary)] rounded px-2 py-1 disabled:opacity-50"
          >
            Install
          </button>
        )}
      </div>
      <p className="text-[11px] text-[var(--muted-foreground-2)] leading-relaxed">{skill.summary}</p>
      <div className="flex flex-wrap gap-1">
        {skill.tags.map((tag) => (
          <span key={tag} className="text-[9px] font-mono border border-[var(--border-1)] rounded px-1.5 py-0.5 text-[var(--muted-foreground-2)]">{tag}</span>
        ))}
      </div>
    </li>
  );
}

function InstalledSkillsList({ skills, loading }: { skills: SavedSkill[]; loading: boolean }): JSX.Element {
  if (loading && skills.length === 0) {
    return <p role="status" className="text-xs text-[var(--muted-foreground-2)]">Loading installed skills…</p>;
  }
  if (skills.length === 0) {
    return <p className="text-xs text-[var(--muted-foreground-2)]">Nothing installed yet. Pick a library card and install it as a draft.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {skills.map((skill) => (
        <li key={skill.id} className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] px-3 py-2 text-xs flex justify-between gap-2">
          <span className="font-medium text-[var(--fg)]">{skill.name}</span>
          <span className="text-[var(--muted-foreground-2)]">{skill.status} · v{skill.version}</span>
        </li>
      ))}
    </ul>
  );
}
