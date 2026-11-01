import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { PageHeader, SkeletonLines, StatusNotice } from "./surface";
import type { AgentPrincipal } from "../types";

type Capability = "gmail_read" | "run_status" | "queue_run" | "send_email";
type Role = "owner" | "admin" | "operator" | "member" | "viewer";
interface Employee { id: string; slug: string; version: number; config: { name: string } }
interface Grant { subjectType: string; subjectId: string; capabilityId: string; resourceId: string; lifecycle: string }
interface ExternalCapability { capabilityId: string; tool: string; label: string; schemaVersion: string; resourceArguments: string[]; effect: "read" | "approval_required" }
interface Policy { employeeVersion: number; toolScopes: string[]; grants: Grant[]; externalCapabilities?: ExternalCapability[]; externalResourceArguments?: Record<string, string> }
interface Approval { approvalId: string; employeeId: string; employeeVersion: number; actorId: string; executionContextId?: string; employeeContext?: { employeeId: string; employeeVersion: number; executionContextId: string; resourceIds: string[] }; action: string; resourceId?: string; payload: Record<string, unknown>; status: string; createdAt: number; expiresAt: number }
interface GmailCandidate { messageId: string; threadId: string; from: string; subject: string; date: string }
interface EmployeeActor extends AgentPrincipal { source?: "web-session" }

const CAPABILITIES: { id: Capability; label: string; scope: string; description: string; resource: string }[] = [
  { id: "gmail_read", label: "Read selected Gmail messages", scope: "gmail:read", description: "Read only message IDs selected here from your connected Gmail account. This does not grant mailbox search to the employee.", resource: "Selected Gmail message" },
  { id: "run_status", label: "Read run status", scope: "runs:read", description: "Read status for an explicitly granted run ID.", resource: "Run ID" },
  { id: "queue_run", label: "Queue a coding run", scope: "sandbox:exec", description: "Create a Shiba coding run for an explicitly granted repository URL. Requires exact-payload approval.", resource: "Repository URL" },
  { id: "send_email", label: "Send email", scope: "email:send", description: "Send using an explicitly granted mailbox. Requires exact-payload approval.", resource: "Mailbox ID" },
];
const ROLES: Role[] = ["owner", "admin", "operator", "member", "viewer"];
const FIELD = "w-full border border-[var(--border-1)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--fg)] focus:border-[var(--primary)] focus:outline-none";
const BUTTON = "border border-[var(--border-1)] bg-[var(--panel)] px-3 py-2 text-xs font-mono text-[var(--fg)] hover:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function EmployeeToolPolicyView(): JSX.Element {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [principals, setPrincipals] = useState<EmployeeActor[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [actorId, setActorId] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [selected, setSelected] = useState<Capability[]>([]);
  const [resources, setResources] = useState<Record<Capability, string>>({ gmail_read: "", run_status: "", queue_run: "", send_email: "" });
  const [externalCapabilities, setExternalCapabilities] = useState<ExternalCapability[]>([]);
  const [selectedExternal, setSelectedExternal] = useState<string[]>([]);
  const [externalResources, setExternalResources] = useState<Record<string, string>>({});
  const [externalArguments, setExternalArguments] = useState<Record<string, string>>({});
  const [gmailQuery, setGmailQuery] = useState("");
  const [gmailCandidates, setGmailCandidates] = useState<GmailCandidate[]>([]);
  const [gmailSearching, setGmailSearching] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeEmployees = useMemo(() => employees, [employees]);

  const refreshApprovals = useCallback(async () => {
    const body = await readJson<{ approvals?: Approval[] }>(await fetch("/api/employee-tools/approvals", { credentials: "same-origin" }));
    setApprovals(Array.isArray(body.approvals) ? body.approvals : []);
  }, []);

  const refreshPolicy = useCallback(async (id: string, preferredActor?: string) => {
    const next = await readJson<Policy>(await fetch(`/api/employee-tools/${encodeURIComponent(id)}/policy`, { credentials: "same-origin" }));
    setPolicy(next);
    const active = next.grants.filter((grant) => grant.lifecycle === "active");
    const actorGrant = active.find((grant) => grant.subjectType === "actor" && (!preferredActor || grant.subjectId === preferredActor));
    const roleGrant = active.find((grant) => grant.subjectType === "role");
    const actor = preferredActor ?? actorGrant?.subjectId ?? "";
    setActorId(actor);
    if (roleGrant?.subjectId && ROLES.includes(roleGrant.subjectId as Role)) setRole(roleGrant.subjectId as Role);
    const caps = CAPABILITIES.filter((cap) => next.toolScopes.includes(`mcp:shiba:${cap.id}`) && active.some((grant) => grant.capabilityId === `mcp:shiba:${cap.id}`));
    setSelected(caps.map((cap) => cap.id));
    const effectiveActor = preferredActor ?? actorGrant?.subjectId;
    const configured = Object.fromEntries(CAPABILITIES.map((cap) => [cap.id, active
      .filter((grant) => grant.capabilityId === `mcp:shiba:${cap.id}` && (grant.subjectType === "workspace" || grant.subjectType === "role" || grant.subjectType === "actor" && grant.subjectId === effectiveActor))
      .map((grant) => grant.resourceId)])) as Record<Capability, string[]>;
    setResources({ gmail_read: configured.gmail_read.join("\n"), run_status: configured.run_status.join("\n"), queue_run: configured.queue_run.join("\n"), send_email: configured.send_email.join("\n") });
    const external = next.externalCapabilities ?? [];
    const selectedIds = next.toolScopes.filter((id) => id.startsWith("mcp:shiba:ext_"));
    setExternalCapabilities(external);
    setSelectedExternal(selectedIds);
    setExternalResources(Object.fromEntries(selectedIds.map((id) => [id, [...new Set(active.filter((grant) => grant.capabilityId === id &&
      (grant.subjectType === "workspace" || grant.subjectType === "actor" && grant.subjectId === effectiveActor)).map((grant) => grant.resourceId))].join("\n")])));
    setExternalArguments({ ...Object.fromEntries(external.map((item) => [item.capabilityId, item.resourceArguments[0] ?? ""])), ...next.externalResourceArguments });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [employeeResponse, principalResponse, identityResponse] = await Promise.all([
          fetch("/api/custom-agents", { credentials: "same-origin" }),
          fetch("/api/agents", { credentials: "same-origin" }),
          fetch("/api/whoami", { credentials: "same-origin" }),
        ]);
        const [employeeBody, principalBody, identityBody] = await Promise.all([
          readJson<{ agents?: Employee[] }>(employeeResponse), readJson<{ principals?: AgentPrincipal[] }>(principalResponse),
          readJson<{ agent?: string }>(identityResponse),
        ]);
        if (cancelled) return;
        const listed = Array.isArray(employeeBody.agents) ? employeeBody.agents : [];
        const registered: EmployeeActor[] = Array.isArray(principalBody.principals) ? principalBody.principals : [];
        const currentIdentity = identityBody.agent?.trim();
        if (currentIdentity && !registered.some((item) => item.principal === currentIdentity)) {
          registered.unshift({ principal: currentIdentity, scopes: [], created: Date.now(), live: true, source: "web-session" });
        }
        setEmployees(listed); setPrincipals(registered);
        const firstEmployee = listed[0]?.id ?? "";
        const firstActor = currentIdentity ?? registered.find((item) => item.live)?.principal ?? registered[0]?.principal ?? "";
        setEmployeeId(firstEmployee); setActorId(firstActor);
        await Promise.all([firstEmployee ? refreshPolicy(firstEmployee, firstActor) : Promise.resolve(), refreshApprovals()]);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [refreshApprovals, refreshPolicy]);

  const chooseEmployee = async (id: string) => {
    setEmployeeId(id); setPolicy(null); setError(null); setNotice(null);
    if (!id) return;
    try { await refreshPolicy(id, actorId); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const chooseActor = async (id: string) => {
    setActorId(id); setError(null); setNotice(null);
    if (!employeeId) return;
    try { await refreshPolicy(employeeId, id); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const save = async () => {
    if (!employeeId || !actorId || !policy || busy) return;
    if ((selected.length || selectedExternal.length) && !principals.some((principal) => principal.principal === actorId && (principal.live || principal.source === "web-session"))) {
      setError("Choose the current web identity or an active MCP principal before granting tools. Inactive principals can still be selected to revoke existing grants.");
      return;
    }
    const resourcesByCapability: Record<string, string[]> = {};
    for (const id of selected) {
      const values = resources[id].split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!values.length) { setError(`Add at least one exact resource for ${id.replaceAll("_", " ")}.`); return; }
      resourcesByCapability[`mcp:shiba:${id}`] = values;
    }
    for (const id of selectedExternal) {
      const capability = externalCapabilities.find((item) => item.capabilityId === id);
      if (!capability?.resourceArguments.includes(externalArguments[id] ?? "")) {
        setError("A selected MCP tool is unavailable or changed. Review it in MCP Servers, or remove its employee grant."); return;
      }
      const values = (externalResources[id] ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!values.length) { setError(`Add exact resource values for ${capability.label}.`); return; }
      resourcesByCapability[id] = values;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      await readJson(await fetch(`/api/employee-tools/${encodeURIComponent(employeeId)}/policy`, {
        method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: policy.employeeVersion, actorId, role, resourcesByCapability,
          ...(selectedExternal.length ? { externalResourceArguments: Object.fromEntries(selectedExternal.map((id) => [id, externalArguments[id]])),
            externalSchemaVersions: Object.fromEntries(selectedExternal.map((id) => [id, externalCapabilities.find((item) => item.capabilityId === id)?.schemaVersion])) } : {}) }),
      }));
      await refreshPolicy(employeeId, actorId);
      setNotice(selected.length || selectedExternal.length ? "Policy saved. Grants are bound to this employee version, actor, role and listed resources." : "All tool grants revoked for this employee version.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const searchGmail = async () => {
    if (!gmailQuery.trim() || gmailSearching) return;
    setGmailSearching(true); setError(null);
    try {
      const body = await readJson<{ results?: GmailCandidate[] }>(await fetch(`/api/connections/gmail/resources?q=${encodeURIComponent(gmailQuery)}&limit=25`, { credentials: "same-origin", cache: "no-store" }));
      setGmailCandidates(Array.isArray(body.results) ? body.results : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setGmailSearching(false); }
  };
  const selectedGmailIds = resources.gmail_read.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const toggleGmailId = (id: string, checked: boolean) => setResources((current) => {
    const values = current.gmail_read.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const next = checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);
    return { ...current, gmail_read: next.join("\n") };
  });

  const decide = async (approval: Approval, approved: boolean) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const endpoint = approval.employeeContext ? `/api/v1/mcp/servers/${encodeURIComponent(approval.employeeId)}/approvals/${encodeURIComponent(approval.approvalId)}`
        : `/api/employee-tools/approvals/${encodeURIComponent(approval.approvalId)}`;
      const result = await readJson<{ dispatch?: { status: string; errorCode?: string } }>(await fetch(endpoint, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify(approval.employeeContext ? { approved } : { employeeId: approval.employeeId, approved }),
      }));
      await refreshApprovals();
      if (approval.employeeContext && approved) {
        if (result.dispatch?.status !== "succeeded") throw new Error(`MCP action ${result.dispatch?.status ?? "not dispatched"}${result.dispatch?.errorCode ? `: ${result.dispatch.errorCode}` : ""}. Inspect its receipt before retrying.`);
        setNotice("Exact MCP payload approved and dispatched. Its durable receipt records success.");
      } else setNotice(approved ? "Exact payload approved. The requesting MCP agent can retry the same call; changed payloads require a new approval." : "Approval denied.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="flex-1 overflow-y-auto p-6"><SkeletonLines rows={5} /></div>;

  return <div className="flex-1 overflow-y-auto">
    <PageHeader title="Employee tool policy" detail="Grant bounded MCP actions to an employee and review exact-payload approvals." />
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {error ? <StatusNotice tone="err">{error}</StatusNotice> : null}
      {notice ? <StatusNotice tone="ok">{notice}</StatusNotice> : null}
      {!employees.length ? <StatusNotice tone="info">Create a bot profile first. This page only configures tool access for existing profiles.</StatusNotice> : null}
      {!principals.some((principal) => principal.live) ? <StatusNotice tone="info">No active MCP principals are registered. Existing grants can still be revoked; granting requires an active principal.</StatusNotice> : null}

      <section className="border border-[var(--border-1)] bg-[var(--card)] p-5 space-y-4">
        <div><h3 className="text-sm font-semibold text-[var(--fg)]">Configure grants</h3><p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Saving replaces this employee’s current grant set. Clear selections and save to revoke access.</p></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-[10px] font-mono uppercase tracking-wider text-[var(--muted-foreground-2)]">Employee
            <select className={FIELD} value={employeeId} onChange={(event) => void chooseEmployee(event.target.value)}>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.config.name || employee.slug}</option>)}</select>
          </label>
          <label className="space-y-1 text-[10px] font-mono uppercase tracking-wider text-[var(--muted-foreground-2)]">Actor identity
            <select className={FIELD} value={actorId} onChange={(event) => void chooseActor(event.target.value)}>{principals.map((principal) => <option key={principal.principal} value={principal.principal}>{principal.principal}{principal.source === "web-session" ? " · current web identity" : principal.live ? " · active MCP" : " · inactive"}</option>)}</select>
          </label>
          <label className="space-y-1 text-[10px] font-mono uppercase tracking-wider text-[var(--muted-foreground-2)]">Role
            <select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as Role)}>{ROLES.map((value) => <option key={value}>{value}</option>)}</select>
          </label>
        </div>
        <div className="space-y-3">{CAPABILITIES.map((capability) => <div key={capability.id} className="border border-[var(--border-1)] p-3">
          <label className="flex items-start gap-2 text-xs text-[var(--fg)]"><input type="checkbox" checked={selected.includes(capability.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, capability.id] : current.filter((value) => value !== capability.id))} />
            <span><span className="font-semibold">{capability.label}</span><span className="ml-2 font-mono text-[10px] text-[var(--muted-foreground-2)]">{capability.scope}</span><span className="mt-1 block text-[var(--muted-foreground-2)]">{capability.description}</span></span>
          </label>
          {selected.includes(capability.id) ? capability.id === "gmail_read" ? <div className="mt-3 space-y-3 text-[10px] text-[var(--muted-foreground-2)]">
            <p>Search reads message metadata from the connected account. Check exact messages to grant; selected IDs are stored in this policy. Thread IDs are shown for context and do not grant whole-thread access.</p>
            <div className="flex gap-2"><input aria-label="Search connected Gmail" className={`${FIELD} normal-case`} value={gmailQuery} onChange={(event) => setGmailQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchGmail(); } }} placeholder="from:… subject:…" /><button type="button" className={BUTTON} disabled={gmailSearching || !gmailQuery.trim()} onClick={() => void searchGmail()}>{gmailSearching ? "Searching…" : "Search Gmail"}</button></div>
            {gmailCandidates.length ? <div className="max-h-56 space-y-2 overflow-auto border border-[var(--border-1)] p-2">{gmailCandidates.map((candidate) => <label key={candidate.messageId} className="flex gap-2"><input type="checkbox" checked={selectedGmailIds.includes(candidate.messageId)} onChange={(event) => toggleGmailId(candidate.messageId, event.target.checked)} /><span><span className="font-semibold text-[var(--fg)]">{candidate.subject || "(no subject)"}</span><span className="block">{candidate.from} · {candidate.date}</span><span className="block font-mono">Message {candidate.messageId} · thread {candidate.threadId}</span></span></label>)}</div> : null}
            <p>Selected: {selectedGmailIds.length ? selectedGmailIds.map((id) => <span key={id} className="mr-1 inline-flex items-center gap-1 border border-[var(--border-1)] px-2 py-1 font-mono">{id}<button type="button" aria-label={`Remove Gmail message ${id}`} onClick={() => toggleGmailId(id, false)}>×</button></span>) : "none"}</p>
          </div> : <label className="mt-3 block text-[10px] font-mono text-[var(--muted-foreground-2)]">Allowed {capability.resource.toLowerCase()} values, one per line<textarea className={`${FIELD} mt-1 min-h-16 normal-case`} value={resources[capability.id]} onChange={(event) => setResources((current) => ({ ...current, [capability.id]: event.target.value }))} placeholder={capability.id === "run_status" ? "run_..." : capability.id === "queue_run" ? "https://github.com/org/repo" : "mailbox-id"} /></label> : null}
        </div>)}</div>
        <div className="space-y-3"><h4 className="text-xs font-semibold text-[var(--fg)]">Reviewed HTTPS MCP tools</h4>
          <p className="text-xs text-[var(--muted-foreground-2)]">Enable and review a server in MCP Servers first. Employee grants allow only exact values in one required string resource argument. Saving grants does not create broad MCP actor access.</p>
          {!externalCapabilities.length ? <p className="text-xs text-[var(--muted-foreground-2)]">No reviewed, healthy MCP tools with a supported resource argument are available.</p> : null}
          {externalCapabilities.map((capability) => <div key={capability.capabilityId} className="border border-[var(--border-1)] p-3 space-y-2">
            <label className="flex items-center gap-2 text-xs text-[var(--fg)]"><input type="checkbox" checked={selectedExternal.includes(capability.capabilityId)} onChange={(event) => setSelectedExternal((current) => event.target.checked ? [...current, capability.capabilityId] : current.filter((id) => id !== capability.capabilityId))} />{capability.label} · {capability.effect === "read" ? "read" : "exact approval required"}</label>
            <p className="text-[10px] font-mono text-[var(--muted-foreground-2)]" title={capability.schemaVersion}>Reviewed schema {capability.schemaVersion.slice(0, 12)}</p>
            {selectedExternal.includes(capability.capabilityId) ? <div className="space-y-2">
              <label className="block text-xs text-[var(--fg)]">Resource argument for {capability.label}<select className={FIELD} value={externalArguments[capability.capabilityId] ?? ""} onChange={(event) => setExternalArguments((current) => ({ ...current, [capability.capabilityId]: event.target.value }))}>{capability.resourceArguments.map((field) => <option key={field}>{field}</option>)}</select></label>
              <label className="block text-xs text-[var(--fg)]">Exact resource values for {capability.label}<textarea className={FIELD} value={externalResources[capability.capabilityId] ?? ""} onChange={(event) => setExternalResources((current) => ({ ...current, [capability.capabilityId]: event.target.value }))} /></label>
            </div> : null}
          </div>)}
          {selectedExternal.filter((id) => !externalCapabilities.some((item) => item.capabilityId === id)).map((id) => <div key={id} className="text-xs text-[var(--warning-fg)]">Saved MCP capability unavailable: {id} <button type="button" className={BUTTON} onClick={() => setSelectedExternal((current) => current.filter((item) => item !== id))}>Remove unavailable grant</button></div>)}
        </div>
        <div className="flex flex-wrap items-center gap-2"><button type="button" className={BUTTON} disabled={busy || !employeeId || !policy || !actorId} onClick={() => void save()}>{busy ? "Saving…" : selected.length || selectedExternal.length ? "Save grants" : "Revoke all grants"}</button><span className="text-[10px] text-[var(--muted-foreground-2)]">{policy ? `Employee version ${policy.employeeVersion}` : "Policy unavailable"}</span></div>
      </section>

      <section className="space-y-3">
        <div><h3 className="text-sm font-semibold text-[var(--fg)]">Pending exact-payload approvals</h3><p className="mt-1 text-xs text-[var(--muted-foreground-2)]">A request appears after an employee MCP agent invokes an approved write action. Approval authorizes only the recorded payload, resource and connection generation.</p></div>
        {!approvals.length ? <div className="border border-dashed border-[var(--border-1)] p-5 text-center text-xs text-[var(--muted-foreground-2)]">No pending employee tool approvals.</div> : approvals.map((approval) => <article key={approval.approvalId} className="border border-[var(--border-1)] bg-[var(--card)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs font-semibold text-[var(--fg)]">{approval.action} · {approval.actorId}</div><span className="text-[10px] font-mono text-[var(--muted-foreground-2)]">Expires {new Date(approval.expiresAt).toLocaleString()}</span></div>
          <div className="text-[10px] font-mono text-[var(--muted-foreground-2)]">Employee {approval.employeeContext?.employeeId ?? approval.employeeId} v{approval.employeeContext?.employeeVersion ?? approval.employeeVersion} · resource {approval.employeeContext?.resourceIds.join(", ") ?? approval.resourceId ?? "—"}{approval.employeeContext?.executionContextId || approval.executionContextId ? ` · context ${approval.employeeContext?.executionContextId ?? approval.executionContextId}` : ""}</div>
          <pre className="max-h-48 overflow-auto border border-[var(--border-1)] bg-[var(--panel)] p-3 text-[10px] text-[var(--fg)]">{JSON.stringify(approval.payload, null, 2)}</pre>
          <div className="flex gap-2"><button type="button" className={BUTTON} disabled={busy} onClick={() => void decide(approval, true)}>Approve exact payload</button><button type="button" className={BUTTON} disabled={busy} onClick={() => void decide(approval, false)}>Deny</button></div>
        </article>)}
      </section>
      <p className="border-l-2 border-[var(--warning-fg)] pl-3 text-xs text-[var(--muted-foreground-2)]">Limits: native employee app tools are Gmail selected-message reads, run status, queue run and send email; this selection flow currently supports Gmail only. Reviewed HTTPS MCP tools additionally support exact values in one required string resource argument. Unsupported schemas and transports fail closed. These grants do not constrain shell/CLI tools in a coding harness; they add no token or MCP credential to the sandbox. External MCP clients still authenticate with their own bearer token.</p>
    </div>
  </div>;
}
