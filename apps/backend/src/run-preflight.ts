import { userOAuthStatus, userProviderOAuthReady } from "./user-provider-oauth-store.js";
import { readUserProviderSecret, type UserSecretKind } from "./user-provider-keys.js";
/**
 * Fail-closed checks before a run is queued or an approval card is minted.
 * Surfaces the same credential gaps the setup doctor reports — never after
 * human approval inside a container.
 */
import type { Env } from "./env.js";
import { assertHarnessAuthorized } from "./auth/index.js";
import { agentCliCatalog } from "./harness/catalog.js";
import { resolveHarness } from "./harness/index.js";
import type { ApprovedRoute } from "./model-connections.js";
import { validateConnectionModel } from "./model-connections.js";
import type { ModelConfigSnapshot } from "./model-policy.js";
import type { CodingTaskInput } from "./opencode-input.js";
import { verifyStandinEnabled, type ExecutionTarget } from "@shiba/shared";
import { assertSandboxRunPreflight, DEFAULT_CODING_RUN_FEATURES } from "./sandbox/preflight.js";
import { HOSTED_PROVIDER_KILL_SWITCH_MESSAGE, isHostedProviderAccessStopped } from "./hosted-provider-kill-switch.js";

export interface RunPreflightInput {
  harness: string;
  codingModel: string;
  route: ApprovedRoute;
  authAccount?: string;
  repoUrl?: string;
  publishPullRequest?: boolean;
  sandboxProvider?: string;
  customAgentProviderId?: string;
  orgId?: string;
  initiatorUserId?: string;
  runtime?: string;
  executionTarget?: ExecutionTarget;
}

function minimalCodingInput(params: RunPreflightInput): CodingTaskInput {
  return {
    repoUrl: params.executionTarget?.kind === "artifact-workspace" ? "" : params.repoUrl ?? "https://github.com/example/repo",
    task: "preflight",
    baseBranch: "main",
    publishPullRequest: params.publishPullRequest ?? false,
    sandboxId: "preflight",
    codingModel: params.codingModel,
    harness: params.harness as CodingTaskInput["harness"],
    ...(params.executionTarget ? { executionTarget: params.executionTarget } : {}),
    ...(params.authAccount !== undefined ? { authAccount: params.authAccount } : {}),
    route: params.route,
    ...(params.initiatorUserId ? { initiatorUserId: params.initiatorUserId } : {}),
  };
}

/**
 * Throws an operator-readable error when the resolved route cannot execute
 * yet (missing secret, unsigned subscription, disabled connection, etc.).
 */
export async function assertModelRunPreflight(
  env: Env,
  params: RunPreflightInput,
  snapshot: ModelConfigSnapshot,
): Promise<void> {
  const harness = resolveHarness(params.harness, env);

  if (params.route.connectionId !== null) {
    const connection = snapshot.connections.find((c) => c.id === params.route.connectionId);
    if (!connection) {
      throw new Error("The selected model connection no longer exists — pick another in the composer or Settings.");
    }
    if (connection.status !== "ready") {
      throw new Error(
        `Model connection ${JSON.stringify(connection.displayName)} is ${connection.status}. ` +
          "Open Providers → test the connection, or choose another route.",
      );
    }
    const problem = validateConnectionModel(connection, params.codingModel, params.harness);
    if (problem !== null) {
      throw new Error(problem);
    }
  }

  const catalog = agentCliCatalog(env).find((entry) => entry.id === harness.name);
  if (catalog?.credential.kind === "worker-secret" && catalog.credential.configured === false) {
    const hint = catalog.credential.setupHint ?? `Set the ${catalog.credential.label} secret on this deployment.`;
    throw new Error(
      `Harness ${JSON.stringify(harness.name)} is missing ${catalog.credential.label}. ${hint}`,
    );
  }

  const localDaemon = params.runtime === "local";
  const personalKinds: Record<string, UserSecretKind> = {
    openai: "openai-api", anthropic: "anthropic-api", google: "google", xai: "xai",
    openrouter: "openrouter", groq: "groq", "github-copilot": "copilot", opencode: "opencode",
    "kimi-code": "kimi", meta: "meta",
    deepseek: "deepseek", zai: "zai", minimax: "minimax", qwen: "qwen", mistral: "mistral",
  };
  const keyKind = personalKinds[params.codingModel.split("/")[0]!];
  const personalKey = params.initiatorUserId && keyKind
    ? await readUserProviderSecret(env, params.initiatorUserId, keyKind) : null;
  const personalOAuth = params.initiatorUserId && keyKind === "xai" && userProviderOAuthReady(env)
    ? (await userOAuthStatus(env, params.initiatorUserId, "xai")).connected : false;
  if (params.initiatorUserId && keyKind && !personalKey && !personalOAuth &&
    params.route.connectionId === null && !localDaemon && !verifyStandinEnabled(env)) {
    throw new Error("Connect this provider in Settings → Providers before starting this task.");
  }
  const hostedGateway = !localDaemon && (params.route.connectionId !== null ||
    (catalog?.credential.kind === "ai-gateway-byok" && !personalKey && !personalOAuth));
  if (hostedGateway && isHostedProviderAccessStopped(env)) {
    throw new Error(`${HOSTED_PROVIDER_KILL_SWITCH_MESSAGE} Connect your own provider in Settings → Providers, or ask an admin to clear SHIBA_HOSTED_PROVIDER_KILL_SWITCH.`);
  }
  if (
    catalog?.credential.kind === "ai-gateway-byok" &&
    !env.AI_GATEWAY_TOKEN?.trim() &&
    !verifyStandinEnabled(env) &&
    !localDaemon &&
    !personalKey &&
    !personalOAuth
  ) {
    throw new Error(
      "AI Gateway is not configured (AI_GATEWAY_TOKEN is unset). " +
        "Add the gateway token, connect Codex with Sign in with ChatGPT, or run Claude on a paired local daemon.",
    );
  }

  await assertHarnessAuthorized(env, harness, minimalCodingInput(params));
}

/** Model authorization and sandbox capabilities are checked together at intake. */
export async function assertRunPreflight(
  env: Env,
  params: RunPreflightInput,
  snapshot: ModelConfigSnapshot,
): Promise<void> {
  await assertModelRunPreflight(env, params, snapshot);
  if (params.runtime === "local") return;

  await assertSandboxRunPreflight(
    env,
    {
      orgId: params.orgId ?? "self-hosted",
      taskProviderId: params.sandboxProvider,
      customAgentProviderId: params.customAgentProviderId,
    },
    DEFAULT_CODING_RUN_FEATURES,
  );
}
