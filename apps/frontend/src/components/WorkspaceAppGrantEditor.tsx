import { useEffect, useRef, useState, type JSX } from "react";
import type { WorkspaceIntegrationConnection, WorkspaceIntegrationGrantsResponse } from "@shiba/shared";
import { saveWorkspaceAppGrant, workspaceAppGrants, workspaceAccessChanged } from "../workspace-integrations-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 text-sm";

export function WorkspaceAppGrantEditor({ workspaceId, connection, isCurrent, onClose, onChanged, onAccessLost }: {
  workspaceId: string; connection: WorkspaceIntegrationConnection; isCurrent: () => boolean;
  onClose: () => void; onChanged: () => void; onAccessLost: () => void;
}): JSX.Element {
  const [directory, setDirectory] = useState<WorkspaceIntegrationGrantsResponse | null>(null);
  const [employeeId, setEmployeeId] = useState(""), [actorId, setActorId] = useState("");
  const [permissions, setPermissions] = useState<Array<"discover" | "execute">>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const controller = useRef(new AbortController()), alive = useRef(false), pending = useRef(false);
  const scope = useRef(isCurrent); scope.current = isCurrent;
  const active = () => alive.current && scope.current() && !controller.current.signal.aborted;
  const validate = (body: WorkspaceIntegrationGrantsResponse) => {
    if (body.connectionId !== connection.id || body.connectionVersion !== connection.version) throw new Error("The shared account changed. Refresh accounts before reviewing its grants.");
    return body;
  };
  const fail = (cause: unknown) => {
    if (!active()) return;
    if (workspaceAccessChanged(cause)) { setDirectory(null); setPermissions([]); onAccessLost(); }
    setError(cause instanceof Error ? cause.message : "Workspace permissions are unavailable.");
  };
  useEffect(() => {
    alive.current = true; const abort = new AbortController(); controller.current = abort;
    void workspaceAppGrants(workspaceId, connection.id, abort.signal).then((body) => { if (active()) setDirectory(validate(body)); })
      .catch(fail).finally(() => { if (active()) setLoading(false); });
    return () => { alive.current = false; abort.abort(); };
    // The caller keys this editor by actor, workspace and connection version.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Exact scope is fixed by the keyed mount and checked before every completion.
  }, []);
  const choose = (employee: string, actor: string) => {
    setEmployeeId(employee); setActorId(actor); setNotice(null); setError(null);
    const matches = directory?.grants.filter((grant) => grant.employeeId === employee && grant.actorId === actor) ?? [];
    if (matches.length > 1) { setPermissions([]); setError("Multiple grant records were reported. Refresh before changing permissions."); return; }
    setPermissions(matches[0]?.state === "active" ? matches[0].permissions : []);
  };
  const save = async (next: Array<"discover" | "execute">) => {
    if (!active() || pending.current || !directory || !employeeId || !actorId) return;
    const employee = directory.employees.find((item) => item.id === employeeId), actor = directory.actors.find((item) => item.userId === actorId);
    const existing = directory.grants.filter((grant) => grant.employeeId === employeeId && grant.actorId === actorId);
    if (!employee || !actor || existing.length > 1) { setError("Choose current workspace employee and member versions before granting access."); return; }
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const body = await saveWorkspaceAppGrant(workspaceId, connection.id, { employeeId, employeeVersion: employee.version,
        actorId, actorMembershipVersion: actor.version, expectedConnectionVersion: directory.connectionVersion,
        expectedGrantVersion: existing[0]?.version ?? null, permissions: next }, controller.current.signal);
      if (!active()) return;
      setDirectory(validate(body)); setPermissions(next);
      setNotice(next.length ? "Exact employee and member permissions saved. External actions still require approval of their frozen payload." : "This employee and member grant was revoked.");
      onChanged();
    } catch (cause) { fail(cause); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  };
  return <section aria-label={`Workspace permissions for ${connection.providerKey}`} className="mt-4 border border-[var(--line)] bg-[var(--paper)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Exact employee permissions</h4><button type="button" className={BUTTON} onClick={onClose}>Close permissions</button></div>
    <p className="mt-2 text-xs text-[var(--ink-2)]">Choose one saved employee version and one current workspace member. Their membership role controls authority; an employee job title grants none. No permissions are selected automatically for a new grant.</p>
    {loading ? <p role="status" className="mt-3 text-xs">Loading current grant candidates…</p> : null}
    {error && <p role="alert" className="mt-3 text-xs text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3 text-xs">{notice}</p>}
    {directory && <div className="mt-3 grid gap-3">
      <label className="text-xs">Employee<select className={FIELD} value={employeeId} disabled={busy} onChange={(event) => choose(event.target.value, actorId)}><option value="">Choose a saved employee</option>{directory.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · v{employee.version}</option>)}</select></label>
      <label className="text-xs">Workspace member<select className={FIELD} value={actorId} disabled={busy} onChange={(event) => choose(employeeId, event.target.value)}><option value="">Choose a current member</option>{directory.actors.map((actor) => <option key={actor.userId} value={actor.userId}>{actor.userId} · {actor.role} · grant v{actor.version}</option>)}</select></label>
      <fieldset className="grid gap-2 border border-[var(--line)] p-3"><legend className="px-1 text-xs">Allowed use of this exact app account</legend>{([['discover', 'Discover available app actions'], ['execute', 'Request approved actions']] as const).map(([permission, label]) => <label key={permission} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={permissions.includes(permission)} disabled={busy || !employeeId || !actorId} onChange={(event) => setPermissions((previous) => event.target.checked ? [...previous.filter((item) => item !== permission), permission] : previous.filter((item) => item !== permission))} />{label}</label>)}</fieldset>
      <p className="text-xs text-[var(--ink-2)]">Execute permission does not approve an action or its arguments. A human must review each external write separately. This form starts no model or employee run.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy || !employeeId || !actorId || !permissions.length || Boolean(error)} onClick={() => { void save(permissions); }}>Save exact grant</button><button type="button" className={BUTTON} disabled={busy || !employeeId || !actorId} onClick={() => { void save([]); }}>Revoke selected grant</button></div>
    </div>}
  </section>;
}
