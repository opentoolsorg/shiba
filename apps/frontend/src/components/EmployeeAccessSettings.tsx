import { useEffect, useState, type JSX } from "react";
import type { EmployeeAccessGrant, EmployeeAccessLevel, EmployeeAccessSettings as Settings, EmployeeDelegationAccessSettings } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const levels: EmployeeAccessLevel[] = ["none", "view", "chat", "manage"];
const field = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs";

async function read<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Employee access unavailable.");
  return body;
}

export function EmployeeAccessSettings({ workspaceId, employeeId, onAccessChange }: { workspaceId: string; employeeId: string; onAccessChange?: (level: EmployeeAccessLevel) => void }): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [principals, setPrincipals] = useState<Array<Pick<EmployeeAccessGrant, "principalKind" | "principalId" | "name">>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const endpoint = `/api/governance/employees/${encodeURIComponent(employeeId)}/access`;
  useEffect(() => {
    const controller = new AbortController();
    setSettings(null); setError(null); setNotice(null);
    const init = { headers: teamWorkspaceHeaders(workspaceId), credentials: "same-origin" as const, signal: controller.signal };
    void (async () => {
      const access = await read<Settings>(await fetch(endpoint, init));
      if (controller.signal.aborted) return;
      setSettings(access);
      if (access.level !== "manage") return;
      const [workspace, groups] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}`, init).then(read<{ workspace: { members: Array<{ userId: string }> } }>),
        fetch(`/api/governance/${workspaceId}/groups`, init).then(read<{ groups: Array<{ groupId: string; name: string }> }>),
      ]);
      if (!controller.signal.aborted) setPrincipals([
        { principalKind: "everyone", principalId: "*", name: "Everyone" },
        ...workspace.workspace.members.map((member) => ({ principalKind: "user" as const, principalId: member.userId, name: member.userId })),
        ...groups.groups.map((group) => ({ principalKind: "group" as const, principalId: group.groupId, name: group.name })),
      ]);
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Employee access unavailable."); });
    return () => controller.abort();
  }, [workspaceId, endpoint]);

  async function save(principal: typeof principals[number], level: EmployeeAccessLevel | "inherit") {
    setBusy(true); setError(null); setNotice(null);
    try {
      const updated = await read<Settings>(await fetch(endpoint, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({ principalKind: principal.principalKind, principalId: principal.principalId, level }) }));
      setSettings(updated); onAccessChange?.(updated.level); setNotice("Access updated and recorded in the audit log.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Employee access unavailable."); }
    finally { setBusy(false); }
  }

  return <section aria-label="Employee access" className="mt-4 border-t border-[var(--line)] pt-4">
    <h3 className="text-sm font-medium">Access</h3>
    <p className="mt-1 text-xs text-[var(--ink-2)]">None hides this employee. View is read-only. Chat can talk and answer approvals. Manage can change settings, routines and skills. Workspace owners and admins always have manage access.</p>
    <p className="mt-2 text-xs text-[var(--ink-2)]">A member override takes priority, then the highest group level, then Everyone. Everyone starts at manage.</p>
    {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
    {notice ? <p role="status" className="mt-2 text-xs">{notice}</p> : null}
    {!settings && !error ? <p role="status">Loading access…</p> : null}
    {settings && settings.level !== "manage" ? <p className="mt-2 text-xs">Your access: {settings.level}. Manage access is required to make changes.</p> : null}
    {settings?.level === "manage" ? <div className="mt-3 grid gap-2">{principals.map((principal) => {
      const grant = settings.grants.find((row) => row.principalKind === principal.principalKind && row.principalId === principal.principalId);
      return <label key={`${principal.principalKind}:${principal.principalId}`} className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="break-all">{principal.name}{principal.principalKind === "group" ? " · Group" : ""}</span>
        <select aria-label={`${principal.name} access`} className={field} disabled={busy} value={grant?.level ?? (principal.principalKind === "everyone" ? "manage" : "inherit")} onChange={(event) => void save(principal, event.target.value as EmployeeAccessLevel | "inherit")}>
          {principal.principalKind !== "everyone" ? <option value="inherit">Inherit</option> : null}
          {levels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>;
    })}</div> : null}
    {settings?.canManageIncomingDelegation ? <IncomingDelegationAccess key={`${workspaceId}:${employeeId}`} workspaceId={workspaceId} endpoint={`${endpoint}?policy=incoming-delegation`} /> : null}
  </section>;
}

function IncomingDelegationAccess({ workspaceId, endpoint }: { workspaceId: string; endpoint: string }): JSX.Element {
  const [policy, setPolicy] = useState<EmployeeDelegationAccessSettings | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { headers: teamWorkspaceHeaders(workspaceId), signal: controller.signal })
      .then(read<EmployeeDelegationAccessSettings>)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPolicy(next);
        setSelected(next.allowedEmployeeIds);
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Incoming access unavailable.");
      });
    return () => controller.abort();
  }, [endpoint, workspaceId]);

  async function save() {
    if (!policy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await read<EmployeeDelegationAccessSettings>(await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ expectedRevision: policy.revision, allowedEmployeeIds: selected }),
      }));
      setPolicy(next);
      setSelected(next.allowedEmployeeIds);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Incoming access unavailable.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = !!policy && (selected.length !== policy.allowedEmployeeIds.length || selected.some((id) => !policy.allowedEmployeeIds.includes(id)));
  return <fieldset className="mt-4 min-w-0 border-t border-[var(--line)]">
    <legend className="pr-2 text-sm font-medium">Incoming delegation</legend>
    <p className="mt-1 text-xs text-[var(--ink-2)]">Only selected employees would be allowed to request a handoff. With none selected, all requests are blocked. Delegated execution is not available yet.</p>
    {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
    {!policy && !error ? <p role="status" className="mt-2 text-xs">Loading incoming access…</p> : null}
    {policy && !policy.candidates.length ? <p className="mt-2 text-xs">No other active employees in this workspace.</p> : null}
    {policy?.candidates.map(({ id, name }) => <label key={id} className="flex min-h-11 items-center gap-2 text-xs">
      <input type="checkbox" checked={selected.includes(id)} disabled={busy || (selected.length >= 32 && !selected.includes(id))} onChange={(event) => {
        setSaved(false);
        setSelected(event.target.checked ? [...selected, id] : selected.filter((value) => value !== id));
      }} />
      <span className="min-w-0 break-words">{name}</span>
    </label>)}
    {policy ? <button type="button" className={`${field} mt-2 disabled:opacity-50`} disabled={!dirty || busy} onClick={() => void save()}>Save incoming access</button> : null}
    {saved ? <p role="status" className="mt-2 text-xs">Incoming access saved.</p> : null}
  </fieldset>;
}
