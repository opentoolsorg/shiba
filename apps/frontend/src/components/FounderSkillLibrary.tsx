import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { validateEmployeeBundle, type EmployeeBundle } from "@shiba/shared";
import { reloadSavedSkills, useSavedSkills } from "../saved";
import { EmployeeBundleReview } from "./EmployeeBundleReview";
import { FounderReviewSchedule } from "./FounderReviewSchedule";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

interface LibrarySkill {
  id: string;
  name: string;
  description: string;
  author: string;
  schedule: { label: string; cron: string; timezone: string };
  integrationCatalogIds: string[];
  requiresSensitiveApproval: boolean;
  installed?: boolean;
  installedSkillId?: string;
  installedStatus?: "draft" | "review" | "active" | "disabled";
  installedVersion?: number;
}
const button = "min-h-11 border border-[var(--border-1)] rounded px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";
function librarySkill(value: unknown): value is LibrarySkill {
  if (!value || typeof value !== "object") return false;
  const row = value as LibrarySkill;
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.description === "string" &&
    typeof row.author === "string" && typeof row.schedule?.label === "string" && typeof row.schedule.cron === "string" &&
    typeof row.schedule.timezone === "string" && Array.isArray(row.integrationCatalogIds) && row.integrationCatalogIds.every((id) => typeof id === "string");
}

export function FounderSkillLibrary({ workspaceId, canManage = true, onInstalled }: { workspaceId?: string; canManage?: boolean; onInstalled?: () => void } = {}): JSX.Element {
  return workspaceId ? <FounderLibraryContent key={workspaceId} workspaceId={workspaceId} canManage={canManage} savedSkills={[]} onInstalled={onInstalled} /> : <PersonalFounderLibrary />;
}

function PersonalFounderLibrary(): JSX.Element {
  const saved = useSavedSkills();
  return <FounderLibraryContent canManage savedSkills={saved.skills} onInstalled={() => { void reloadSavedSkills().catch(() => {}); }} />;
}

function FounderLibraryContent({ workspaceId, canManage, savedSkills, onInstalled }: { workspaceId?: string; canManage: boolean; savedSkills: Array<{ id: string; status: LibrarySkill["installedStatus"]; version: number }>; onInstalled?: () => void }): JSX.Element {
  const [skills, setSkills] = useState<LibrarySkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ recipe: EmployeeBundle; signal: AbortSignal } | null>(null);
  const [schedule, setSchedule] = useState<LibrarySkill | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const loadEpoch = useRef(0);
  const visibleSkills = skills?.map((skill) => {
    const installed = savedSkills.find((saved) => saved.id === skill.installedSkillId);
    return installed ? { ...skill, installed: installed.status !== "disabled", installedStatus: installed.status, installedVersion: installed.version } : skill;
  });
  const current = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;

  const load = useCallback(async (signal: AbortSignal) => {
    const epoch = ++loadEpoch.current;
    setError(null);
    try {
      const response = await fetch("/api/founder-skills", { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId), signal });
      const body = await response.json().catch(() => ({})) as { skills?: LibrarySkill[]; error?: string };
      if (controller.current?.signal !== signal || signal.aborted || epoch !== loadEpoch.current) return;
      if (!response.ok || !Array.isArray(body.skills) || !body.skills.every(librarySkill)) throw new Error(body.error ?? `Library could not be loaded (${response.status}).`);
      setSkills(body.skills);
    } catch (cause) {
      if (controller.current?.signal === signal && !signal.aborted && epoch === loadEpoch.current) {
        setError(cause instanceof Error ? cause.message : "Library could not be loaded."); setSkills([]);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void load(active.signal);
    return () => { active.abort(); loadEpoch.current++; };
  }, [load]);

  const install = async (id: string) => {
    const signal = controller.current?.signal;
    if (!canManage || !signal || !current(signal) || pending.current) return;
    pending.current = true; setBusyId(`install-${id}`); setNotice(null); setError(null);
    try {
      const response = await fetch(`/api/founder-skills/${encodeURIComponent(id)}/install`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId), signal });
      const body = await response.json().catch(() => ({})) as { error?: string; skill?: { id?: string; status?: LibrarySkill["installedStatus"]; version?: number } };
      if (!current(signal)) return;
      if (!response.ok || !body.skill?.id) throw new Error(body.error ?? `Install failed (${response.status}).`);
      setSkills((previous) => previous?.map((skill) => skill.id === id ? { ...skill, installed: body.skill?.status !== "disabled", installedSkillId: body.skill?.id, installedStatus: body.skill?.status, installedVersion: body.skill?.version } : skill) ?? []);
      setNotice(`Installed "${id}" as ${body.skill.status ?? "draft"} skill ${body.skill.id}. Review it in your skill list below. No schedule or app permissions were installed.`);
      onInstalled?.();
    } catch (cause) {
      if (current(signal)) setError(cause instanceof Error ? cause.message : "Install failed: the backend could not be reached.");
    } finally {
      if (current(signal)) { pending.current = false; setBusyId(null); }
    }
  };

  const reviewSetup = async (id: string) => {
    const signal = controller.current?.signal;
    if (!signal || !current(signal) || pending.current) return;
    pending.current = true; setBusyId(`setup-${id}`); setNotice(null); setError(null); setSetup(null);
    try {
      const response = await fetch(`/api/founder-skills/${encodeURIComponent(id)}/setup`, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId), signal });
      const body = await response.json().catch(() => ({})) as { recipe?: unknown; error?: string };
      if (!current(signal)) return;
      if (!response.ok) throw new Error(body.error ?? `Setup unavailable (${response.status}).`);
      setSetup({ recipe: validateEmployeeBundle(body.recipe), signal });
    } catch (cause) {
      if (current(signal)) setError(cause instanceof Error ? cause.message : "Setup could not be loaded.");
    } finally {
      if (current(signal)) { pending.current = false; setBusyId(null); }
    }
  };

  return (
    <section aria-labelledby="founder-skill-library-heading" className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--section)] p-4 flex flex-col gap-3">
      <div>
        <h3 id="founder-skill-library-heading" className="text-sm font-semibold text-[var(--fg)]">Founder skill library</h3>
        <p className="text-xs text-[var(--muted-foreground-2)] mt-1">Six setup templates. Install draft instructions, review current versions, and optionally configure private recurring review drafts. Review drafts do not execute employees or access apps. Scheduled connector execution remains unavailable; external actions need their own approval.</p>
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--destructive)]">{error}</p> : null}
      {error && controller.current ? <button type="button" className={button} disabled={busyId !== null} onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal); }}>Retry founder library</button> : null}
      {notice ? <p role="status" className="text-xs text-[var(--primary)]">{notice}</p> : null}
      {skills === null ? <p className="text-xs text-[var(--muted-foreground-2)]">Loading library…</p> : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {visibleSkills?.map((skill) => (
            <li key={skill.id} className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-3 flex flex-col gap-2">
              <span className="text-xs font-semibold text-[var(--fg)]">{skill.name}</span>
              <p className="text-[11px] text-[var(--muted-foreground-2)] leading-relaxed flex-1">{skill.description}</p>
              <p className="text-[10px] font-mono text-[var(--muted-foreground-2)]">Suggested: {skill.schedule.label} · not scheduled</p>
              {skill.integrationCatalogIds.length ? <p className="text-[10px] text-[var(--muted-foreground-3)]">Required sources: {skill.integrationCatalogIds.join(", ")} · verify supported actions and connect separately</p> : null}
              {skill.requiresSensitiveApproval ? <p className="text-[10px] text-[var(--warning-fg)]">Sensitive updates stay drafts until separately approved.</p> : null}
              {skill.installed ? <p className="text-xs">Installed instructions: {skill.installedStatus ?? "review required"}{skill.installedVersion ? ` · v${skill.installedVersion}` : ""}</p> : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!canManage || busyId !== null || skill.installed} onClick={() => void install(skill.id)} className={button}>{skill.installed ? "Instructions installed" : "Install draft"}</button>
                {!workspaceId && <button type="button" aria-label={`Review employee setup: ${skill.name}`} disabled={busyId !== null} onClick={() => void reviewSetup(skill.id)} className={button}>Review employee setup</button>}
                {canManage && <button type="button" aria-label={`Schedule review drafts: ${skill.name}`} disabled={busyId !== null} onClick={() => { setSchedule(skill); setSetup(null); }} className={button}>Schedule review drafts</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {schedule && <FounderReviewSchedule key={`${workspaceId ?? "personal"}:${schedule.id}`} libraryId={schedule.id} name={schedule.name} suggested={schedule.schedule} workspaceId={workspaceId} onClose={() => setSchedule(null)} />}
      {setup ? <EmployeeBundleReview key={setup.recipe.profile.provenance?.id} recipe={setup.recipe} onClose={() => setSetup(null)} onImported={(result) => {
        if (!current(setup.signal)) return;
        setSetup(null); setNotice(`Archived bot ${result.employeeId} and ${result.skillIds.length} draft skill(s) created. Review and restore the bot in Agents, activate selected skill versions, and configure your provider and exact integration grants before work. No executable schedule was installed.`);
        onInstalled?.();
      }} /> : null}
    </section>
  );
}
