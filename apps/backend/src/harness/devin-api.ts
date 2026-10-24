/**
 * `devin-api` harness — runs a Devin cloud session via api.devin.ai instead
 * of the in-container CLI loop. The Worker orchestrates create + poll; the
 * sandbox only prints the resulting PR URL or diff (no API key in argv).
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { runDevinSessionWorkflow } from "../devin-session/workflow.js";
import { readProviderSecretForOrg } from "../user-provider-keys.js";
import type { Env } from "../env.js";
import {
  assertSupportedModel,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import { DEVIN_EGRESS_HOSTS, DEVIN_PROVIDERS, devinCredentialsConfig, parseDevinEvent } from "./devin.js";

export class DevinApiHarness implements AgentHarness {
  readonly name = "devin-api" as const;
  readonly supportedProviders = DEVIN_PROVIDERS;

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...DEVIN_EGRESS_HOSTS];
  }

  egressOverrides(input: CodingTaskInput) {
    const userId = input.initiatorUserId?.trim() ?? "";
    if (userId === "") return [];
    return DEVIN_EGRESS_HOSTS.map((host) => ({
      host,
      handler: "devinUser" as const,
      params: { userId },
    }));
  }

  configFile(): ReturnType<typeof devinCredentialsConfig> {
    return devinCredentialsConfig();
  }

  env(_input: CodingTaskInput, _configPath: string | null): Record<string, string> {
    return {};
  }

  /**
   * Emits a shell one-liner that prints workflow output — the real API calls
   * run in verify() on the Worker where keys stay out of the container.
   */
  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return ["echo", "Devin API session runs on the Worker; see run output events."];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseDevinEvent(line);
  }

  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: false,
      supportsResume: false,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: false,
      supportsConversationRollback: false,
      execAllowlist: [],
      supportedRuntimes: ["sandbox"],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

/** Worker-side entry: run the Devin API session and return human-readable output lines. */
export async function runDevinApiTask(env: Env, input: CodingTaskInput): Promise<string[]> {
  const userId = input.initiatorUserId?.trim() || "self-hosted";
  const apiKey =
    (await readProviderSecretForOrg(env, userId, "devin")) ?? env.DEVIN_API_KEY?.trim() ?? "";
  const orgId = env.DEVIN_ORG_ID?.trim() ?? "";
  if (!apiKey) throw new Error("Devin API key is not configured for this user or deployment.");
  if (!orgId) throw new Error("DEVIN_ORG_ID is not configured on this deployment.");
  const outcome = await runDevinSessionWorkflow({
    apiKey,
    orgId,
    prompt: input.task,
    repoUrl: input.repoUrl,
  });
  const lines = [`Devin session ${outcome.sessionId} (${outcome.status}): ${outcome.sessionUrl}`];
  if (outcome.pullRequestUrl) lines.push(`Pull request: ${outcome.pullRequestUrl}`);
  if (outcome.diffText) lines.push(outcome.diffText);
  return lines;
}

export const devinApiHarness = new DevinApiHarness();
