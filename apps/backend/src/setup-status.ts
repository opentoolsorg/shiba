/**
 * GET /api/setup/status — reports which deploy-time pieces are configured so
 * the onboarding checklist can show live state instead of static steps.
 * Returns presence signals and relevant setting names, never secret values.
 */
import { getSsoReadiness } from "@shiba/auth/better-auth";
import type { Env } from "./env.js";
import { isGitHubPublishConfigured } from "./github-auth.js";
import { describeRoleModels, type RoleModelStatus } from "./agents/roles.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import { readModelConfig } from "./model-policy.js";
import { isAccessConfigured } from "./request-auth.js";
import { isHostedProviderAccessStopped } from "./hosted-provider-kill-switch.js";
import { runSetupDoctor, type SetupDoctorReport } from "./setup-doctor.js";
import { listMissingSetupSecrets, type SetupSecretRow } from "./setup-missing-secrets.js";
import { LOCAL_RUNTIME_FLAG } from "@shiba/shared";
import { readModelRoute, readToolSetup, type ModelRouteStatus, type ToolSetupRow } from "./model-route-status.js";
import { getIntegrationProvider } from "./ports/connector/registry.js";

export interface SetupStatus {
  slack: {
    signingSecret: boolean;
    botToken: boolean;
    approvers: number;
    channelRepos: boolean;
  };
  github: { token: boolean; app: boolean; publish: boolean; webhookSecret: boolean };
  linear: { webhookSecret: boolean; apiToken: boolean; defaultRepo: boolean };
  slackVerification: { signingSecret: boolean };
  teams: {
    appId: boolean;
    appPassword: boolean;
    tenantId: boolean;
    workspaceId: boolean;
    approvers: number;
    channelRepos: boolean;
  };
  gateway: { id: string; token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown"; hostedAccessStopped: boolean };
  access: { required: boolean };
  betterAuth: { configured: boolean };
  /** `enabled` means the OIDC handler will mount; lists hold setting names only. */
  sso: { enabled: boolean; configured: string[]; missing: string[]; conflicting: string[] };
  models: { orchestrator: string; coding: string; harness: string; roles: RoleModelStatus[] };
  automations: { enabled: boolean; typeSafe: boolean };
  mailbox: { addressOverride: boolean; sendEnabled: boolean };
  /** WS02 transactional email lane (verification, reset, invitations). */
  transactionalEmail: { senderConfigured: boolean; queueBound: boolean };
  /** Feature flags the dashboard can use without probing dark routes. */
  deployment: {
    localRuntime: boolean;
    /** A service binding or URL is present, even if the adapter is disabled. */
    openConnectorBound: boolean;
    openConnectorEnabled: boolean;
    operatorReviewEnabled: boolean;
    workspaceEvents: boolean;
  };
  missingSecrets: SetupSecretRow[];
  /** Can this workspace start a task right now, and if not, what to do. */
  modelRoute: ModelRouteStatus;
  toolSetup: ToolSetupRow[];
  doctor: SetupDoctorReport;
}

/** HEAD the resolved gateway URL: distinguishes reachable/401/other without a body. */
async function probeGateway(env: Env): Promise<SetupStatus["gateway"]["reachable"]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const url = await env.AI.gateway(env.GATEWAY_ID || "default").getUrl("google-ai-studio");
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    if (response.status === 401 || response.status === 403) return "unauthorized";
    return response.status < 500 ? "yes" : "error";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

export async function readSetupStatus(env: Env, probe = true, initiatorUserId?: string): Promise<SetupStatus> {
  const approvers = (env.SLACK_APPROVERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const teamsApprovers = (env.TEAMS_APPROVERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const sso = getSsoReadiness(env);
  const modelSnapshot = await readModelConfig(env);
  const rolePins = modelSnapshot.policy.rolePins;
  const base: Omit<SetupStatus, "doctor" | "deployment" | "missingSecrets" | "modelRoute" | "toolSetup"> = {
    slack: {
      signingSecret: Boolean(env.SLACK_SIGNING_SECRET),
      botToken: Boolean(env.SLACK_BOT_TOKEN),
      approvers: approvers.length,
      channelRepos: Boolean(env.SLACK_CHANNEL_REPOS),
    },
    github: {
      token: Boolean(env.GITHUB_TOKEN?.trim()),
      app: Boolean(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim()),
      publish: isGitHubPublishConfigured(env),
      webhookSecret: Boolean(env.GITHUB_WEBHOOK_SECRET),
    },
    linear: {
      webhookSecret: Boolean(env.LINEAR_WEBHOOK_SECRET?.trim()),
      apiToken: Boolean(env.LINEAR_API_KEY?.trim() || env.LINEAR_OAUTH_ACCESS_TOKEN?.trim()),
      defaultRepo: Boolean(env.LINEAR_DEFAULT_REPO_URL?.trim()),
    },
    slackVerification: {
      signingSecret: Boolean(env.SLACK_SIGNING_SECRET?.trim()),
    },
    teams: {
      appId: Boolean(env.TEAMS_APP_ID?.trim()),
      appPassword: Boolean(env.TEAMS_APP_PASSWORD?.trim()),
      tenantId: Boolean(env.TEAMS_APP_TENANT_ID?.trim()),
      workspaceId: Boolean(env.TEAMS_WORKSPACE_ID?.trim()),
      approvers: teamsApprovers.length,
      channelRepos: Boolean(env.TEAMS_CHANNEL_REPOS?.trim()),
    },
    gateway: {
      id: env.GATEWAY_ID || "default",
      token: Boolean(env.AI_GATEWAY_TOKEN),
      reachable: probe ? await probeGateway(env) : "unknown",
      hostedAccessStopped: isHostedProviderAccessStopped(env),
    },
    access: { required: isAccessConfigured(env) },
    betterAuth: { configured: isBetterAuthConfigured(env) },
    sso: {
      enabled: sso.ready,
      configured: sso.settings.filter(name => !sso.missing.includes(name) && !sso.conflicting.includes(name)),
      missing: sso.missing,
      conflicting: sso.conflicting,
    },
    models: {
      orchestrator: env.ORCHESTRATOR_MODEL,
      coding: env.CODING_MODEL,
      harness: env.AGENT_HARNESS ?? "opencode",
      roles: describeRoleModels(env, rolePins, modelSnapshot),
    },
    automations: {
      enabled:
        env.AUTOMATIONS_ENABLED !== "false" &&
        env.AUTOMATIONS_ENABLED !== "0" &&
        env.AUTOMATIONS_ENABLED !== "off",
      typeSafe: Boolean(env.TYPESAFE_API_KEY),
    },
    mailbox: {
      addressOverride: Boolean(env.AGENT_MAILBOX?.trim()),
      sendEnabled: env.SEND_EMAIL !== undefined,
    },
    transactionalEmail: {
      senderConfigured: Boolean(env.BETTER_AUTH_VERIFICATION_FROM?.trim()),
      queueBound: env.EMAIL_QUEUE !== undefined,
    },
  };
  const doctor = await runSetupDoctor(env, { gateway: base.gateway, initiatorUserId });
  const missingSecrets = listMissingSetupSecrets(env);
  const openConnectorBound = Boolean(env.OPEN_CONNECTOR) || Boolean(env.OPEN_CONNECTOR_URL?.trim());
  return {
    ...base,
    deployment: {
      localRuntime: env[LOCAL_RUNTIME_FLAG] === "1" && env.LocalDispatch !== undefined,
      openConnectorBound,
      openConnectorEnabled: getIntegrationProvider(env).capabilities.configured,
      operatorReviewEnabled: env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED === "true",
      workspaceEvents: env.WorkspaceEvents !== undefined,
    },
    missingSecrets,
    modelRoute: await readModelRoute(env, initiatorUserId, base.gateway.reachable),
    toolSetup: readToolSetup(env),
    doctor,
  };
}
