/**
 * Pre-run setup diagnostics — shared by GET /api/setup/status and the
 * `pnpm shiba doctor` CLI. Never returns secret values.
 */
import { AGENT_ROLES, type AgentRole } from "@shiba/shared";
import { describeRoleModels } from "./agents/roles.js";
import type { Env } from "./env.js";
import { agentCliCatalog } from "./harness/catalog.js";
import { isGitHubPublishConfigured, resolveGitHubCredential } from "./github-auth.js";
import { assertRunPreflight, type RunPreflightInput } from "./run-preflight.js";
import { defaultCodingFromConnection, soleReadyConnection } from "./model-defaults.js";
import { readModelConfig, resolveCodingRoute, type ModelConfigSnapshot } from "./model-policy.js";

export type DoctorSeverity = "ok" | "warn" | "error";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  message: string;
  fix?: string;
}

export interface DoctorRoleRow {
  role: AgentRole;
  harness: string;
  model: string;
  connectionId: string | null;
  ok: boolean;
  message?: string;
  fix?: string;
}

export interface SetupDoctorReport {
  ok: boolean;
  checkedAt: number;
  findings: DoctorFinding[];
  roles: DoctorRoleRow[];
}

function push(
  findings: DoctorFinding[],
  id: string,
  severity: DoctorSeverity,
  message: string,
  fix?: string,
): void {
  findings.push({ id, severity, message, ...(fix !== undefined ? { fix } : {}) });
}

async function probeGitHub(env: Env, findings: DoctorFinding[]): Promise<void> {
  if (!isGitHubPublishConfigured(env)) {
    push(
      findings,
      "github.credentials",
      "warn",
      "No GitHub credential configured (clone/PR flows need GITHUB_TOKEN or a GitHub App).",
      "Set GITHUB_TOKEN in .dev.vars locally or wrangler secrets in production, or configure GITHUB_APP_* vars.",
    );
    return;
  }
  const cred = await resolveGitHubCredential(env).catch(() => null);
  if (cred === null) {
    push(
      findings,
      "github.credentials",
      "error",
      "GitHub App env is present but no installation token could be minted.",
      "Check GITHUB_APP_INSTALLATION_ID or GITHUB_APP_REPO_INSTALLATIONS for the target repo.",
    );
    return;
  }
  if (cred.mode === "pat") {
    const response = await fetch(`${cred.apiBase}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cred.token}`,
        "User-Agent": "shiba-doctor",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (response === null || !response.ok) {
      push(
        findings,
        "github.token",
        "error",
        `GitHub token rejected (${response?.status ?? "network error"}).`,
        "Mint a new fine-grained or classic PAT with repo access and update GITHUB_TOKEN.",
      );
      return;
    }
    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (scopes.length > 0 && !scopes.includes("repo") && !scopes.includes("public_repo")) {
      push(
        findings,
        "github.scopes",
        "error",
        `GitHub PAT scopes ${scopes.join(", ")} are missing repo access.`,
        "Regenerate the token with the repo scope (or Contents + Pull requests on a fine-grained PAT).",
      );
    } else {
      push(findings, "github.token", "ok", "GitHub token accepted the /user probe.");
    }
  } else {
    push(findings, "github.app", "ok", "GitHub App installation token minted successfully.");
  }
}

async function roleRows(env: Env, snapshot: ModelConfigSnapshot): Promise<DoctorRoleRow[]> {
  const rolePins = snapshot.policy.rolePins;
  const described = describeRoleModels(env, rolePins, snapshot);
  const sole = soleReadyConnection(snapshot);
  const rows: DoctorRoleRow[] = [];
  for (const role of AGENT_ROLES) {
    const row = described.find((r) => r.role === role);
    if (row === undefined) continue;
    let connectionId: string | null = row.connectionId ?? null;
    if (connectionId === null && sole !== null) {
      const pair = defaultCodingFromConnection(sole);
      if (pair !== null && pair.harness === row.harness && pair.model === row.model) {
        connectionId = sole.id;
      }
    }
    let route;
    try {
      route = resolveCodingRoute(snapshot, {
        connectionId,
        model: row.model,
        harness: row.harness,
      });
    } catch (error) {
      rows.push({
        role,
        harness: row.harness,
        model: row.model,
        connectionId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        fix: "Fix the role pin in Settings → Models or adjust model connections in Providers.",
      });
      continue;
    }
    const preflight: RunPreflightInput = {
      harness: row.harness,
      codingModel: row.model,
      route,
    };
    try {
      await assertRunPreflight(env, preflight, snapshot);
      rows.push({
        role,
        harness: row.harness,
        model: row.model,
        connectionId: route.connectionId,
        ok: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let fix = "Open Agents & MCP → connect the subscription lane, or add the Worker secret named in the error.";
      if (message.includes("AI_GATEWAY_TOKEN")) {
        fix = "Set AI_GATEWAY_TOKEN and configure BYOK in Cloudflare AI Gateway.";
      }
      if (message.includes("model connection")) {
        fix = "Providers → test the connection, or register a BYOK alias on the connection.";
      }
      rows.push({
        role,
        harness: row.harness,
        model: row.model,
        connectionId: route.connectionId,
        ok: false,
        message,
        fix,
      });
    }
  }
  return rows;
}

function checkGateway(
  gateway: { token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" },
  findings: DoctorFinding[],
): void {
  if (!gateway.token) {
    push(
      findings,
      "gateway.token",
      "warn",
      "AI_GATEWAY_TOKEN is unset — gateway-backed harnesses cannot reach providers.",
      "npx wrangler secret put AI_GATEWAY_TOKEN (or add to .dev.vars for local dev).",
    );
  } else if (gateway.reachable === "unauthorized") {
    push(
      findings,
      "gateway.reachable",
      "warn",
      "AI Gateway returned 401/403 — token or Authenticated Gateway policy may be wrong.",
      "Verify the token in the Cloudflare dashboard and retry GET /api/setup/status.",
    );
  } else if (gateway.reachable === "error") {
    push(findings, "gateway.reachable", "warn", "AI Gateway probe failed.", "Check network egress and GATEWAY_ID.");
  } else if (gateway.reachable === "yes") {
    push(findings, "gateway.reachable", "ok", "AI Gateway endpoint responded.");
  }
}

function checkContainers(env: Env, findings: DoctorFinding[]): void {
  const hasSandbox = env.Sandbox !== undefined;
  if (!hasSandbox) {
    push(
      findings,
      "containers.binding",
      "warn",
      "Sandbox binding is absent — sandbox runs cannot start in this process.",
      "Use wrangler dev with containers enabled, or deploy to Cloudflare with the Sandbox binding.",
    );
  } else {
    push(findings, "containers.binding", "ok", "Sandbox binding is present.");
  }
}

function checkSecretsCatalog(env: Env, findings: DoctorFinding[]): void {
  for (const agent of agentCliCatalog(env)) {
    if (agent.credential.kind === "worker-secret" && agent.credential.configured === false) {
      push(
        findings,
        `harness.${agent.id}.secret`,
        "warn",
        `${agent.label} is enabled but ${agent.credential.label} is missing.`,
        agent.credential.setupHint ?? `Set ${agent.credential.label}.`,
      );
    }
  }
}

export async function runSetupDoctor(
  env: Env,
  hints: { gateway: { token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" } },
): Promise<SetupDoctorReport> {
  const checkedAt = Date.now();
  const findings: DoctorFinding[] = [];

  checkGateway(hints.gateway, findings);
  checkContainers(env, findings);
  checkSecretsCatalog(env, findings);
  await probeGitHub(env, findings);

  const snapshot = await readModelConfig(env);
  const sole = soleReadyConnection(snapshot);
  if (sole !== null) {
    push(
      findings,
      "models.single-connection",
      "ok",
      `One ready model connection (${sole.displayName}) — all unpinned roles route through it.`,
    );
  }

  const roles = await roleRows(env, snapshot);
  for (const row of roles) {
    if (!row.ok) {
      push(findings, `role.${row.role}`, "error", `Role ${row.role}: ${row.message ?? "not runnable"}`, row.fix);
    }
  }

  const ok = !findings.some((f) => f.severity === "error") && roles.every((r) => r.ok);
  return { ok, checkedAt, findings, roles };
}

/** Human-readable lines for the CLI — no JSON secrets. */
export function formatDoctorReport(report: SetupDoctorReport): string {
  const lines: string[] = [];
  lines.push(report.ok ? "setup doctor: ok" : "setup doctor: problems found");
  for (const finding of report.findings) {
    const tag = finding.severity === "ok" ? "✓" : finding.severity === "warn" ? "!" : "✗";
    lines.push(`${tag} ${finding.id}: ${finding.message}`);
    if (finding.fix) lines.push(`    fix: ${finding.fix}`);
  }
  for (const row of report.roles) {
    const route = `${row.role} → ${row.harness} / ${row.model}` + (row.connectionId ? ` (${row.connectionId})` : "");
    lines.push(row.ok ? `✓ ${route}` : `✗ ${route}: ${row.message ?? "blocked"}`);
    if (!row.ok && row.fix) lines.push(`    fix: ${row.fix}`);
  }
  return lines.join("\n");
}
