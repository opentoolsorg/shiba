/**
 * ChatGPT plan harness — Sign in with ChatGPT (SIWC) + `codex app-server`.
 * Only a short-lived ACCESS_TOKEN enters the sandbox; refresh stays on the
 * ChatGptAuth Durable Object (Worker-side when auth.openai.com allows it).
 */
import { resolveCodexSubscriptionHome, type CodexHomeLayout } from "@shiba/shared";
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import {
  codexChatGptPlanDriverPath,
  codexChatGptPlanDriverSource,
} from "./codex-chatgpt-plan-driver.js";
import {
  assertSupportedModel,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessConfigFile,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import { CodexErrorEvent, parseCodexEvent } from "./codex.js";
import {
  CODEX_DEVICE_AUTH_HOSTS,
  codexDeviceAuthHomeDir,
  codexDeviceAuthVolumeForUser,
  usesCodexDeviceAuth,
} from "./codex-device-auth.js";

export const CODEX_SUBSCRIPTION_PROVIDERS = ["openai-subscription"] as const;
export const CODEX_SUBSCRIPTION_HOSTS = ["api.openai.com"] as const;
export const CODEX_SUBSCRIPTION_SHARED_HOME = "/root/.shiba/codex/shared";

export function codexSubscriptionAccount(input: Pick<CodingTaskInput, "authAccount">): string {
  return input.authAccount ?? "default";
}

export function codexSubscriptionHome(input: Pick<CodingTaskInput, "authAccount">): CodexHomeLayout {
  const account = codexSubscriptionAccount(input).replace(/[^a-z0-9-]/g, "-");
  return resolveCodexSubscriptionHome({
    sharedHomePath: CODEX_SUBSCRIPTION_SHARED_HOME,
    shadowHomePath: account === "default" ? undefined : `/root/.shiba/codex/acc-${account}`,
  });
}

export function codexSubscriptionHomeDir(input: Pick<CodingTaskInput, "authAccount">): string {
  const layout = codexSubscriptionHome(input);
  return layout.effectiveHomePath ?? layout.sharedHomePath;
}

export function codexSubscriptionInstanceId(input: Pick<CodingTaskInput, "authAccount">): string {
  return `codex-sub:${codexSubscriptionHomeDir(input)}`;
}

export { codexSubscriptionAccountFromInstanceId } from "@shiba/shared";

export function codexPlanHomeForRun(input: CodingTaskInput): string {
  const user = input.initiatorUserId?.trim() ?? "anonymous";
  return `/root/.shiba/codex/plan/${user.replace(/[^a-zA-Z0-9._-]/g, "_")}/${input.sandboxId}`;
}

export class CodexUsageLimitError extends Error {
  constructor(detail: string) {
    super(`Codex subscription usage limit reached. ${detail}`);
    this.name = "CodexUsageLimitError";
  }
}

export class CodexSubscriptionHarness implements AgentHarness {
  readonly name = "codex-subscription" as const;
  readonly supportedProviders = CODEX_SUBSCRIPTION_PROVIDERS;
  readonly auth = { instanceId: codexSubscriptionInstanceId };

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...CODEX_SUBSCRIPTION_HOSTS];
  }

  continuationKey(input: { authAccount?: string }): string {
    return codexSubscriptionHome(input).continuationKey;
  }

  setupCommands(input: CodingTaskInput, _workdir: string): readonly (readonly string[])[] {
    if (usesCodexDeviceAuth(input)) {
      const home = codexDeviceAuthHomeDir(input);
      return [["mkdir", "-p", home], ["chmod", "700", home]];
    }
    const home = codexPlanHomeForRun(input);
    return [["mkdir", "-p", home], ["chmod", "700", home]];
  }

  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile[] {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    if (usesCodexDeviceAuth(input)) return [];
    const model = stripProvider(input.codingModel);
    const threadId = input.chatgptThreadId ?? null;
    return [
      {
        path: codexChatGptPlanDriverPath(sandboxId),
        contents: codexChatGptPlanDriverSource({
          task: input.task,
          model: model === "auto" ? null : model,
          threadId,
        }),
      },
    ];
  }

  env(input: CodingTaskInput, _configPath: string | null): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    const env: Record<string, string> = {
      CODEX_HOME: usesCodexDeviceAuth(input) ? codexDeviceAuthHomeDir(input) : codexPlanHomeForRun(input),
      CODEX_DISABLE_TELEMETRY: "1",
    };
    if (input.chatgptAccessToken) env.ACCESS_TOKEN = input.chatgptAccessToken;
    return env;
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    if (usesCodexDeviceAuth(input)) {
      const model = stripProvider(input.codingModel);
      return ["codex", "exec", "--json", "--model", model, "--cd", workdir, input.task];
    }
    return ["node", codexChatGptPlanDriverPath(input.sandboxId)];
  }

  parseEvent(line: string): HarnessEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const record = JSON.parse(trimmed) as { type?: string; threadId?: string };
      if (record.type === "thread" && record.threadId) {
        return { kind: "progress", text: `thread:${record.threadId}` };
      }
    } catch {
      // fall through to codex parser
    }
    try {
      return parseCodexEvent(line);
    } catch (error) {
      if (error instanceof CodexErrorEvent && /usage|rate.?limit|quota/i.test(error.detail)) {
        throw new CodexUsageLimitError(error.detail);
      }
      throw error;
    }
  }

  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: true,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: true,
      supportsConversationRollback: false,
      execAllowlist: [["node"]],
      supportedRuntimes: ["sandbox"],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    if (usesCodexDeviceAuth(input)) {
      if (!input.initiatorUserId) {
        return { ok: false, reason: "device-auth requires a signed-in user (initiatorUserId)." };
      }
      if (codexDeviceAuthVolumeForUser(input.initiatorUserId) === null) {
        return {
          ok: false,
          reason:
            "Per-user Codex device-auth volumes are not available on this deployment yet (#119/#123). Run `codex login --device-auth` in your sandbox after volumes ship, or use Sign in with ChatGPT in Settings.",
        };
      }
    }
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const codexSubscriptionHarness = new CodexSubscriptionHarness();
