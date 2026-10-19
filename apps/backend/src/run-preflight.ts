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
import { verifyStandinEnabled } from "@shiba/shared";

export interface RunPreflightInput {
  harness: string;
  codingModel: string;
  route: ApprovedRoute;
  authAccount?: string;
  repoUrl?: string;
  publishPullRequest?: boolean;
}

function minimalCodingInput(params: RunPreflightInput): CodingTaskInput {
  return {
    repoUrl: params.repoUrl ?? "https://github.com/example/repo",
    task: "preflight",
    baseBranch: "main",
    publishPullRequest: params.publishPullRequest ?? false,
    sandboxId: "preflight",
    codingModel: params.codingModel,
    harness: params.harness as CodingTaskInput["harness"],
    ...(params.authAccount !== undefined ? { authAccount: params.authAccount } : {}),
    route: params.route,
  };
}

/**
 * Throws an operator-readable error when the resolved route cannot execute
 * yet (missing secret, unsigned subscription, disabled connection, etc.).
 */
export async function assertRunPreflight(
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

  if (
    catalog?.credential.kind === "ai-gateway-byok" &&
    !env.AI_GATEWAY_TOKEN?.trim() &&
    !verifyStandinEnabled(env)
  ) {
    throw new Error(
      "AI Gateway is not configured (AI_GATEWAY_TOKEN is unset). " +
        "Add the gateway token or connect a subscription harness with /api/auth/*.",
    );
  }

  await assertHarnessAuthorized(env, harness, minimalCodingInput(params));
}
