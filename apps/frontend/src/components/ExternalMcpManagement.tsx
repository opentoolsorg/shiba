import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import type { AgentPrincipal } from "../types";

interface ExternalTool {
  id: string;
  remoteName: string;
  capabilityId: string;
  gatewayName: string;
  description: string;
  schemaVersion: string;
  effect: "unreviewed" | "read" | "approval_required";
  reviewedAt: number | null;
  enabled: boolean;
  recommendedEffect?: "unreviewed" | "read" | "approval_required";
}
interface ExternalServer {
  id: string;
  name: string;
  transport: "streamable_http";
  endpoint: string;
  credentialRef: string | null;
  status: string;
  health: string;
  healthStale: boolean;
  lastCheckedAt: number | null;
  lastErrorCode: string | null;
  catalogId?: string | null;
  connectionLabel?: string | null;
  visibility?: "private" | "workspace";
  authMode?: string;
  tools: ExternalTool[];
}
interface ExternalAccess {
  capabilityId: string;
  principal: string;
  enabled: boolean;
}
interface ExternalApproval {
  approvalId: string;
  action: string;
  actorId: string;
  payload: Record<string, unknown>;
  expiresAt: number;
  status: string;
}
const base = "/api/v1/mcp/servers";
const inputClass =
  "w-full border border-[var(--border-1)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--fg)] focus:border-[var(--primary)] focus:outline-none";
const buttonClass =
  "border border-[var(--border-1)] bg-[var(--panel)] px-3 py-2 text-[10px] font-mono text-[var(--fg)] hover:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json", ...init.headers } } : {}),
  });
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

/** Owner-controlled upstream registry; remote discovery happens only on explicit button press. */
export function ExternalMcpManagement(): JSX.Element {
  const [servers, setServers] = useState<ExternalServer[]>([]);
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [access, setAccess] = useState<Record<string, ExternalAccess[]>>({});
  const [approvals, setApprovals] = useState<Record<string, ExternalApproval[]>>({});
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [effectChoices, setEffectChoices] = useState<Record<string, "read" | "approval_required">>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshEpoch = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    const [serverBody, tokenBody] = await Promise.all([
      request<{ servers: ExternalServer[] }>(base),
      request<{ principals?: AgentPrincipal[] }>("/api/agents"),
    ]);
    if (epoch !== refreshEpoch.current) return;
    const nextServers = Array.isArray(serverBody.servers) ? serverBody.servers : [];
    setPrincipals(Array.isArray(tokenBody.principals) ? tokenBody.principals : []);
    setServers(nextServers);
    const details = await Promise.all(
      nextServers.map(async (server) => {
        const [detail, pending] = await Promise.all([
          request<{ tools?: ExternalTool[]; access?: ExternalAccess[] }>(
            `${base}/${server.id}/tools`,
          ),
          request<{ approvals?: ExternalApproval[] }>(`${base}/${server.id}/approvals`),
        ]);
        return {
          id: server.id,
          tools: detail.tools ?? [],
          access: detail.access ?? [],
          approvals: pending.approvals ?? [],
        };
      }),
    );
    if (epoch !== refreshEpoch.current) return;
    const detailsById = new Map(details.map((detail) => [detail.id, detail]));
    setServers(
      nextServers.map((server) => ({
        ...server,
        tools: detailsById.get(server.id)?.tools ?? server.tools ?? [],
      })),
    );
    setAccess(Object.fromEntries(details.map((detail) => [detail.id, detail.access])));
    setApprovals(Object.fromEntries(details.map((detail) => [detail.id, detail.approvals])));
  }, []);
  const refreshDetails = useCallback(async (id: string) => {
    const epoch = ++refreshEpoch.current;
    const [detail, pending] = await Promise.all([
      request<{ tools?: ExternalTool[]; access?: ExternalAccess[] }>(`${base}/${id}/tools`),
      request<{ approvals?: ExternalApproval[] }>(`${base}/${id}/approvals`),
    ]);
    if (epoch !== refreshEpoch.current) return;
    setServers((current) =>
      current.map((server) =>
        server.id === id ? { ...server, tools: detail.tools ?? [] } : server,
      ),
    );
    setAccess((current) => ({ ...current, [id]: detail.access ?? [] }));
    setApprovals((current) => ({ ...current, [id]: pending.approvals ?? [] }));
  }, []);
  useEffect(() => {
    void refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [refresh]);

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const create = () =>
    run(
      "create",
      async () => {
        await request(base, {
          method: "POST",
          body: JSON.stringify({
            name,
            transport: "streamable_http",
            url: endpoint,
            credentialRef: credentialRef || null,
          }),
        });
        setName("");
        setEndpoint("");
        setCredentialRef("");
      },
      "Draft saved. Upstream access stays disabled until the operator trusts its host and you explicitly discover, review, and enable capabilities.",
    );
  const discover = (server: ExternalServer) =>
    run(
      `discover:${server.id}`,
      async () => {
        await request(`${base}/${server.id}/discover`, { method: "POST", body: "{}" });
        await refreshDetails(server.id);
      },
      "Schema discovery completed. Review each capability before enabling it.",
    );
  const disableServer = (server: ExternalServer) =>
    run(
      `disable:${server.id}`,
      async () => {
        await request(`${base}/${server.id}`, { method: "DELETE" });
        await refreshDetails(server.id);
      },
      "Server disabled and capability access revoked.",
    );
  const updateSettings = (server: ExternalServer, form: FormData) =>
    run(
      `update:${server.id}`,
      async () => {
        await request(`${base}/${server.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: String(form.get("name") ?? ""),
            url: String(form.get("url") ?? ""),
            credentialRef: String(form.get("credentialRef") ?? "") || null,
          }),
        });
        await refreshDetails(server.id);
      },
      "Settings saved. Changing endpoint or credential reference disables tools until they are rediscovered and reviewed.",
    );

  return (
    <section className="space-y-4 border border-[var(--border-1)] bg-[var(--card)] p-5 rounded-[var(--radius-button)]">
      <div>
        <h3 className="text-sm font-semibold text-[var(--fg)]">External MCP servers</h3>
        <p className="mt-1 max-w-3xl text-xs text-[var(--muted-foreground-2)]">
          Register HTTPS Streamable HTTP servers you own or trust. Only exact public hostnames
          configured by the deployment operator can be contacted. OAuth, SSE-only, stdio,
          local/private hosts, metadata targets, custom auth headers, and redirects are unsupported.
          Credentials are referenced by Worker secret name only.
        </p>
      </div>
      {error ? (
        <p
          role="alert"
          className="border border-[var(--destructive)] p-2 text-xs text-[var(--destructive)]"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="border border-[var(--success)] p-2 text-xs text-[var(--success)]"
        >
          {notice}
        </p>
      ) : null}
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          className={inputClass}
          aria-label="MCP server name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Server name"
        />
        <input
          className={inputClass}
          aria-label="MCP server HTTPS endpoint"
          required
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://mcp.example.com/mcp"
        />
        <input
          className={inputClass}
          aria-label="MCP credential reference"
          value={credentialRef}
          onChange={(event) => setCredentialRef(event.target.value)}
          placeholder="MCP_CREDENTIAL_TEAM (optional)"
        />
        <button
          type="submit"
          className={buttonClass}
          disabled={busy !== null || !name.trim() || !endpoint.trim()}
        >
          Save draft
        </button>
      </form>

      {!servers.length ? (
        <div className="border border-dashed border-[var(--border-1)] p-4 text-center text-xs text-[var(--muted-foreground-2)]">
          No external MCP servers registered. The built-in Shiba gateway is separate.
        </div>
      ) : null}
      {servers.map((server) => (
        <article key={server.id} className="space-y-3 border border-[var(--border-1)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold text-[var(--fg)]">{server.name}</h4>
              {server.catalogId ? (
                <p className="font-mono text-[10px] text-[var(--muted-foreground-2)]">
                  {server.catalogId}
                  {server.connectionLabel ? `:${server.connectionLabel}` : ""} · {server.visibility ?? "private"} ·{" "}
                  {server.authMode ?? "bearer_ref"}
                </p>
              ) : null}
              <code className="break-all text-[10px] text-[var(--muted-foreground-2)]">
                {server.endpoint}
              </code>
              <p className="mt-1 text-[10px] font-mono text-[var(--muted-foreground-2)]">
                {server.transport} · {server.status} · health {server.health}
                {server.healthStale ? " (stale)" : ""}
                {server.lastCheckedAt
                  ? ` · checked ${new Date(server.lastCheckedAt).toLocaleString()}`
                  : " · never tested"}
                {server.lastErrorCode ? ` · ${server.lastErrorCode}` : ""}
              </p>
              <p className="text-[10px] text-[var(--muted-foreground-2)]">
                Credential reference: {server.credentialRef ?? "none"}. Secret values are never
                shown or stored in the catalog.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={busy !== null}
                onClick={() => void discover(server)}
              >
                {busy === `discover:${server.id}` ? "Checking…" : "Discover / retry"}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy !== null || server.status === "disabled"}
                onClick={() => void disableServer(server)}
              >
                Disable server
              </button>
            </div>
          </div>
          <form
            className="grid gap-2 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              void updateSettings(server, new FormData(event.currentTarget));
            }}
          >
            <input
              name="name"
              aria-label={`Edit ${server.name} name`}
              className={inputClass}
              defaultValue={server.name}
              maxLength={80}
            />
            <input
              name="url"
              aria-label={`Edit ${server.name} endpoint`}
              className={inputClass}
              defaultValue={server.endpoint}
            />
            <div className="flex gap-2">
              <input
                name="credentialRef"
                aria-label={`Edit ${server.name} credential reference`}
                className={inputClass}
                defaultValue={server.credentialRef ?? ""}
                placeholder="MCP_CREDENTIAL_*"
              />
              <button type="submit" className={buttonClass} disabled={busy !== null}>
                Save settings
              </button>
            </div>
          </form>
          {server.tools.map((tool) => {
            const recommendation = tool.recommendedEffect === "unreviewed" ? undefined : tool.recommendedEffect;
            const effectiveEffect = effectChoices[tool.id] ??
              (tool.effect === "unreviewed" ? (recommendation ?? "") : tool.effect);
            const principalGrants = (access[server.id] ?? [])
              .filter((grant) => grant.capabilityId === tool.capabilityId && grant.enabled)
              .map((grant) => grant.principal);
            return (
              <div key={tool.id} className="space-y-2 border-t border-[var(--border-1)] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-mono text-xs text-[var(--fg)]">{tool.gatewayName}</strong>
                  <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">
                    → {tool.remoteName}
                  </span>
                  <span className="text-[10px]">
                    {tool.enabled
                      ? "enabled"
                      : tool.effect === "unreviewed"
                        ? "unreviewed"
                        : "disabled"}
                  </span>
                </div>
                <p className="max-w-3xl whitespace-pre-wrap text-xs text-[var(--muted-foreground-2)]">
                  Untrusted server description: {tool.description || "(none)"}
                </p>
                <p className="break-all font-mono text-[9px] text-[var(--muted-foreground-2)]">
                  {tool.capabilityId} · schema {tool.schemaVersion}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[10px] text-[var(--muted-foreground-2)]">
                    Reviewed effect{" "}
                    <select
                      aria-label={`Effect for ${tool.remoteName}`}
                      className={inputClass}
                      value={effectiveEffect}
                      onChange={(event) => {
                        if (
                          event.target.value === "read" ||
                          event.target.value === "approval_required"
                        )
                          setEffectChoices((current) => ({
                            ...current,
                            [tool.id]: event.target.value as "read" | "approval_required",
                          }));
                      }}
                    >
                      <option value="">Select a reviewed effect</option>
                      <option value="read">Known read-only</option>
                      <option value="approval_required">
                        May mutate · approval for every call
                      </option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy !== null || !effectiveEffect}
                    onClick={() =>
                      void run(
                        `review:${tool.id}`,
                        async () => {
                          await request(`${base}/${server.id}/tools/${tool.id}/review`, {
                            method: "POST",
                            body: JSON.stringify({
                              effect: effectiveEffect,
                              schemaVersion: tool.schemaVersion,
                            }),
                          });
                          await refreshDetails(server.id);
                        },
                        "Effect review saved; capability remains disabled until enabled.",
                      )
                    }
                  >
                    Review effect
                  </button>
                  {!tool.enabled ? (
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy !== null || tool.effect === "unreviewed"}
                      onClick={() =>
                        void run(
                          `enable:${tool.id}`,
                          async () => {
                            await request(`${base}/${server.id}/tools/${tool.id}/enable`, {
                              method: "POST",
                              body: JSON.stringify({ schemaVersion: tool.schemaVersion }),
                            });
                            await refreshDetails(server.id);
                          },
                          "Capability enabled with its reviewed effect policy.",
                        )
                      }
                    >
                      Enable
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy !== null}
                      onClick={() =>
                        void run(
                          `disable-tool:${tool.id}`,
                          async () => {
                            await request(`${base}/${server.id}/tools/${tool.id}/disable`, {
                              method: "POST",
                              body: JSON.stringify({ schemaVersion: tool.schemaVersion }),
                            });
                            await refreshDetails(server.id);
                          },
                          "Capability disabled.",
                        )
                      }
                    >
                      Disable
                    </button>
                  )}
                </div>
                {tool.enabled ? (
                  <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-[10px]">
                    <legend className="mb-1 text-[var(--muted-foreground-2)]">
                      Grant this capability to active MCP principals with the mcp:external scope:
                    </legend>
                    {principals
                      .filter(
                        (principal) => principal.live && principal.scopes.includes("mcp:external"),
                      )
                      .map((principal) => (
                        <label key={principal.principal} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={principalGrants.includes(principal.principal)}
                            onChange={(event) =>
                              void run(
                                `grant:${tool.id}:${principal.principal}`,
                                async () => {
                                  await request(`${base}/${server.id}/tools/${tool.id}/grant`, {
                                    method: "POST",
                                    body: JSON.stringify({
                                      principal: principal.principal,
                                      enabled: event.target.checked,
                                    }),
                                  });
                                  await refreshDetails(server.id);
                                },
                                "Principal capability grant updated.",
                              )
                            }
                          />
                          {principal.principal}
                        </label>
                      ))}
                    {!principals.some(
                      (principal) => principal.live && principal.scopes.includes("mcp:external"),
                    ) ? (
                      <span className="text-[var(--muted-foreground-2)]">
                        Create an active MCP token with mcp:external scope first.
                      </span>
                    ) : null}
                  </fieldset>
                ) : null}
              </div>
            );
          })}
          {(approvals[server.id] ?? []).map((approval) => (
            <div
              key={approval.approvalId}
              className="border-l-2 border-[var(--warning-fg)] pl-3 text-xs"
            >
              <p>
                {approval.action} · {approval.actorId} · expires{" "}
                {new Date(approval.expiresAt).toLocaleString()}
              </p>
              <pre className="my-2 max-h-40 overflow-auto text-[10px]">
                {JSON.stringify(approval.payload, null, 2)}
              </pre>
              <div className="flex gap-2">
                {[true, false].map((approved) => (
                  <button
                    key={String(approved)}
                    type="button"
                    className={buttonClass}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        `approval:${approval.approvalId}`,
                        async () => {
                          await request(`${base}/${server.id}/approvals/${approval.approvalId}`, {
                            method: "POST",
                            body: JSON.stringify({ approved }),
                          });
                          await refreshDetails(server.id);
                        },
                        approved
                          ? "Exact external MCP call approved and dispatched. Check the invocation receipt for its outcome."
                          : "External MCP call denied.",
                      )
                    }
                  >
                    {approved ? "Approve and dispatch exact call" : "Deny"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
