/**
 * GET /api/setup/status — reports which deploy-time pieces are configured so
 * the onboarding checklist can show live state instead of static steps.
 * Booleans only: never echo secret values or names of unrelated vars.
 */
import type { Env } from "./env.js";
import { isGitHubPublishConfigured } from "./github-auth.js";
import { describeRoleModels, type RoleModelStatus } from "./agents/roles.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import { readModelConfig } from "./model-policy.js";
import { isAccessConfigured } from "./request-auth.js";
import { runSetupDoctor, type SetupDoctorReport } from "./setup-doctor.js";
import { listMissingSetupSecrets, type SetupSecretRow } from "./setup-missing-secrets.js";
import { LOCAL_RUNTIME_FLAG } from "@shiba/shared";

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
  gateway: { id: string; token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" };
  access: { required: boolean };
  betterAuth: { configured: boolean };
  models: { orchestrator: string; coding: string; harness: string; roles: RoleModelStatus[] };
  automations: { enabled: boolean; typeSafe: boolean };
  mailbox: { addressOverride: boolean; sendEnabled: boolean };
  /** Feature flags the dashboard can use without probing dark routes. */
  deployment: {
    localRuntime: boolean;
    openConnectorBound: boolean;
    openConnectorEnabled: boolean;
    operatorReviewEnabled: boolean;
    workspaceEvents: boolean;
  };
  missingSecrets: SetupSecretRow[];
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
  const modelSnapshot = await readModelConfig(env);
  const rolePins = modelSnapshot.policy.rolePins;
  const base: Omit<SetupStatus, "doctor" | "deployment" | "missingSecrets"> = {
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
    gateway: {
      id: env.GATEWAY_ID || "default",
      token: Boolean(env.AI_GATEWAY_TOKEN),
      reachable: probe ? await probeGateway(env) : "unknown",
    },
    access: { required: isAccessConfigured(env) },
    betterAuth: { configured: isBetterAuthConfigured(env) },
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
  };
  const doctor = await runSetupDoctor(env, { gateway: base.gateway, initiatorUserId });
  const missingSecrets = listMissingSetupSecrets(env);
  const openConnectorBound = Boolean(env.OPEN_CONNECTOR) || Boolean(env.OPEN_CONNECTOR_URL?.trim());
  return {
    ...base,
    deployment: {
      localRuntime: env[LOCAL_RUNTIME_FLAG] === "1" && env.LocalDispatch !== undefined,
      openConnectorBound,
      openConnectorEnabled: env.OPEN_CONNECTOR_ENABLED === "1" || env.OPEN_CONNECTOR_ENABLED === "true" || openConnectorBound,
      operatorReviewEnabled: env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED === "true",
      workspaceEvents: env.WorkspaceEvents !== undefined,
    },
    missingSecrets,
    doctor,
  };
}
