/**
 * Providers — connect the AI coding agents that run your tasks (Claude,
 * Codex, Antigravity, Cursor, Devin + the pre-installed sandbox CLI
 * catalog).
 * The MCP gateway itself lives on Agents & MCP.
 */
import { type JSX, useEffect, useState } from "react";
import { useSetupStatus, type SetupStatus } from "../live-status";
import { ConnectionsCard } from "./ModelRoutingSection";
import {
  type AgentCliCredential,
  SUBSCRIPTION_AUTH,
  SubscriptionConnect,
  type SubscriptionId,
  type SubscriptionStatus,
  subscriptionChip,
} from "./SubscriptionConnect";

export function gatewayCredentialState(
  gateway: SetupStatus["gateway"] | undefined,
): { tone: "ok" | "warning" | "neutral"; label: string; hint: string | null } {
  if (gateway === undefined || gateway.reachable === "unknown") {
    return { tone: "neutral", label: "AI Gateway", hint: null };
  }
  if (gateway.reachable === "yes") {
    return { tone: "ok", label: "Ready", hint: null };
  }
  if (gateway.reachable === "unauthorized") {
    return {
      tone: "warning",
      label: "Gateway unauthorized",
      hint: gateway.token
        ? "AI_GATEWAY_TOKEN was rejected by the gateway — rotate it."
        : "Set AI_GATEWAY_TOKEN: npx wrangler secret put AI_GATEWAY_TOKEN",
    };
  }
  return {
    tone: "warning",
    label: "Gateway error",
    hint: "The AI Gateway probe failed — check GATEWAY_ID.",
  };
}

interface AgentCli {
  id: string;
  label: string;
  binary: string;
  version: string;
  defaultModel: string;
  credential: AgentCliCredential;
  docsUrl: string;
}

function statusChip(configured: boolean | null, label?: string): JSX.Element {
  if (configured === true) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--primary)]/30 bg-[var(--primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]">
        <span className="size-1.5 rounded-full bg-[var(--primary)]" />
        {label ?? "Ready"}
      </span>
    );
  }
  if (configured === false) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[var(--warning-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning-fg)]">
        <span className="size-1.5 rounded-full bg-[var(--warning)]" />
        {label ?? "Needs secret"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-foreground-2)]">
      <span className="size-1.5 rounded-full bg-[var(--muted-foreground-3)]" />
      {label ?? "AI Gateway"}
    </span>
  );
}

export function ProvidersView(): JSX.Element {
  const setup = useSetupStatus();
  const gatewayState = gatewayCredentialState(
    setup.state.kind === "data" ? setup.state.data.gateway : undefined,
  );
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [subStatus, setSubStatus] = useState<Record<string, SubscriptionStatus>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) throw new Error(`Agents request failed: ${response.status}`);
        const body = (await response.json()) as { agents?: AgentCli[] };
        if (!cancelled) setAgents(Array.isArray(body.agents) ? body.agents : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscriptionIds = Object.keys(SUBSCRIPTION_AUTH) as SubscriptionId[];
  const catalogById = new Map(agents.map((agent) => [agent.id, agent]));
  // Subscription harnesses render as connectors above, not in the CLI grid.
  const cliAgents = agents.filter(
    (agent) => !(subscriptionIds as readonly string[]).includes(agent.id),
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-[var(--radius-button)] bg-[var(--primary-soft)] border border-[var(--primary)]/20 text-[10px] font-mono text-[var(--primary)] uppercase tracking-wider mb-2 font-bold">
            AI Agent Providers
          </div>
          <h2 className="text-xl font-bold text-[var(--fg)]">Connect your agents</h2>
          <p className="mt-1 text-xs text-[var(--muted-foreground-2)] leading-relaxed max-w-2xl font-mono">
            The AI coding agents that run tasks for you. Connect a provider once — tasks you
            approve can then run in your sandbox with that agent.
          </p>
        </div>

        {error ? (
          <div className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 text-sm text-[var(--destructive)] font-mono text-xs">
            {error}
          </div>
        ) : null}

        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              Connectors
            </h3>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)] font-mono">
              Subscription providers behind the gateway. Connect once; the pinned sandbox CLI
              inherits the credential.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subscriptionIds.map((id) => {
              const spec = SUBSCRIPTION_AUTH[id];
              const row = catalogById.get(id);
              const credential = row?.credential ?? spec.credential;
              return (
                <div
                  key={id}
                  className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 hover:border-[var(--border-2)] transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--fg)]">{spec.label}</span>
                        {row ? (
                          <span className="rounded-[var(--radius-button)] border border-[var(--border-2)]/60 bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted-foreground-2)]">
                            v{row.version}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[var(--muted-foreground-2)]">{spec.blurb}</div>
                    </div>
                    {subscriptionChip(subStatus[id])}
                  </div>

                  <dl className="mt-3 space-y-1.5 text-[12px]">
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Binary</dt>
                      <dd className="font-mono text-[var(--muted-foreground-2)] truncate">{spec.binary}</dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Credential</dt>
                      <dd className="font-mono text-[var(--muted-foreground-2)] truncate">{credential.label}</dd>
                    </div>
                  </dl>

                  <SubscriptionConnect
                    spec={spec}
                    credential={credential}
                    onStatus={(status) =>
                      setSubStatus((prev) =>
                        prev[id] === status ? prev : { ...prev, [id]: status },
                      )
                    }
                  />

                  <div className="mt-3 flex items-center justify-end">
                    <a
                      href={row?.docsUrl ?? spec.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[var(--primary)]/80 hover:text-[var(--primary)] transition-colors"
                    >
                      Docs →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              Model connections
            </h3>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)] font-mono">
              Named credentials a run can route through.
            </p>
          </div>
          <ConnectionsCard />
        </div>

        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              Sandbox Coding CLIs (Pre-installed in Docker Container)
            </h3>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)] font-mono">
              These harnesses execute inside the ephemeral Sandbox container with dummy keys. Real
              credentials are authenticated at AI Gateway egress. Subscription-auth variants live
              under Connectors above.
            </p>
          </div>

          {loading ? (
            <div className="text-xs font-mono text-[var(--muted-foreground-2)]">Loading agent harness catalog…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {cliAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 hover:border-[var(--border-2)] transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--fg)]">{agent.label}</span>
                        <span className="rounded-[var(--radius-button)] border border-[var(--border-2)]/60 bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted-foreground-2)]">
                          v{agent.version}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[var(--muted-foreground-2)]">
                        {agent.binary}
                      </div>
                    </div>
                    {agent.credential.kind === "ai-gateway-byok"
                      ? statusChip(
                          gatewayState.tone === "ok"
                            ? true
                            : gatewayState.tone === "warning"
                              ? false
                              : null,
                          gatewayState.label,
                        )
                      : statusChip(agent.credential.configured)}
                  </div>

                  <dl className="mt-3 space-y-1.5 text-[12px]">
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Model</dt>
                      <dd className="font-mono text-[var(--muted-foreground-2)] truncate">{agent.defaultModel}</dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Credential</dt>
                      <dd className="font-mono text-[var(--muted-foreground-2)] truncate">
                        {agent.credential.label}
                      </dd>
                    </div>
                  </dl>

                  {agent.credential.kind === "ai-gateway-byok" && gatewayState.hint ? (
                    <div className="mt-3 rounded-[var(--radius-button)] border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-2.5 py-1.5 font-mono text-[11px] text-[var(--warning-fg)]/90">
                      {gatewayState.hint}
                    </div>
                  ) : agent.credential.kind !== "ai-gateway-byok" &&
                    agent.credential.configured === false &&
                    agent.credential.setupHint ? (
                    <div className="mt-3 rounded-[var(--radius-button)] border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-2.5 py-1.5 font-mono text-[11px] text-[var(--warning-fg)]/90">
                      {agent.credential.setupHint}
                    </div>
                  ) : null}

                  <div className="mt-3 flex items-center justify-end">
                    <a
                      href={agent.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[var(--primary)]/80 hover:text-[var(--primary)] transition-colors"
                    >
                      Docs →
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
