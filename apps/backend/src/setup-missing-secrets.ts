/**
 * Named setup rows for the dashboard — secret VALUES never leave this module.
 */
import type { Env } from "./env.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import { agentCliCatalog } from "./harness/catalog.js";

export type SetupSecretRow = {
  id: string;
  present: boolean;
  secretName: string;
  whereToSet: string;
  severity: "required" | "optional";
  message: string;
};

function row(
  id: string,
  present: boolean,
  secretName: string,
  whereToSet: string,
  message: string,
  severity: SetupSecretRow["severity"] = "required",
): SetupSecretRow {
  return { id, present, secretName, whereToSet, message, severity };
}

export function listMissingSetupSecrets(env: Env): SetupSecretRow[] {
  const rows: SetupSecretRow[] = [];

  const gateway = Boolean(env.AI_GATEWAY_TOKEN?.trim());
  const subscriptionsOff =
    env.SHIBA_CODEX_SUBSCRIPTION !== "1" &&
    env.SHIBA_CLAUDE_SUBSCRIPTION !== "1" &&
    env.SHIBA_CURSOR_SUBSCRIPTION !== "1" &&
    env.SHIBA_ANTIGRAVITY_SUBSCRIPTION !== "1";
  if (!gateway && subscriptionsOff) {
    rows.push(
      row(
        "secret.ai_gateway_token",
        false,
        "AI_GATEWAY_TOKEN",
        "Cloudflare dashboard → Worker secrets (or `npx wrangler secret put AI_GATEWAY_TOKEN` for dogfood).",
        "Gateway-backed harnesses need AI_GATEWAY_TOKEN, or enable a subscription harness in wrangler vars.",
      ),
    );
  }

  const githubPat = Boolean(env.GITHUB_TOKEN?.trim());
  const githubApp =
    Boolean(env.GITHUB_APP_ID?.trim()) &&
    Boolean(env.GITHUB_APP_PRIVATE_KEY?.trim()) &&
    Boolean(env.GITHUB_APP_INSTALLATION_ID?.trim());
  if (!githubPat && !githubApp) {
    rows.push(
      row(
        "secret.github_publish",
        false,
        "GITHUB_TOKEN or GITHUB_APP_*",
        "Worker secrets: set GITHUB_TOKEN, or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID.",
        "Git clone and draft PR flows need a GitHub App or token.",
      ),
    );
  } else if (!githubPat) {
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"] as const) {
      const present = Boolean(env[name]?.trim());
      if (!present) {
        rows.push(
          row(`secret.${name.toLowerCase()}`, false, name, "Worker secrets (`wrangler secret put`).", `${name} is required when using the GitHub App.`),
        );
      }
    }
  }

  if (!env.GITHUB_WEBHOOK_SECRET?.trim()) {
    rows.push(
      row(
        "secret.github_webhook",
        false,
        "GITHUB_WEBHOOK_SECRET",
        "Worker secrets; must match the GitHub App webhook.",
        "Inbound GitHub webhooks stay unsigned until GITHUB_WEBHOOK_SECRET is set.",
        "optional",
      ),
    );
  }

  for (const name of ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"] as const) {
    rows.push(
      row(
        `secret.${name.toLowerCase()}`,
        Boolean(env[name]?.trim()),
        name,
        "Worker secrets for the Slack coworker surface.",
        name === "SLACK_SIGNING_SECRET"
          ? "Slack event verification needs SLACK_SIGNING_SECRET."
          : "Slack replies and canvas need SLACK_BOT_TOKEN.",
        "optional",
      ),
    );
  }

  const openConnectorBound = Boolean(env.OPEN_CONNECTOR) || Boolean(env.OPEN_CONNECTOR_URL?.trim());
  if (openConnectorBound) {
    for (const name of ["OPEN_CONNECTOR_ADMIN_TOKEN", "OPEN_CONNECTOR_RUNTIME_TOKEN"] as const) {
      rows.push(
        row(
          `secret.${name.toLowerCase()}`,
          Boolean(env[name]?.trim()),
          name,
          "Worker secrets after deploying the OpenConnector sibling (`docs/OPENCONNECTOR.md`).",
          `${name} is required when OPEN_CONNECTOR is bound.`,
        ),
      );
    }
  }

  if (isBetterAuthConfigured(env)) {
    rows.push(
      row(
        "secret.better_auth_secret",
        true,
        "BETTER_AUTH_SECRET",
        "Already configured.",
        "Dashboard auth is enabled.",
        "optional",
      ),
    );
  }

  for (const agent of agentCliCatalog(env)) {
    if (agent.credential.kind === "worker-secret" && !agent.credential.configured) {
      rows.push(
        row(
          `secret.harness.${agent.id}`,
          false,
          agent.credential.label,
          agent.credential.setupHint ?? "Worker secrets.",
          `${agent.label} is enabled but ${agent.credential.label} is missing.`,
        ),
      );
    }
  }

  return rows;
}