import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_HOSTS,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";

export const PI_PROVIDERS = ["anthropic", "openai", "google", "xai"] as const;

const PI_PROVIDER_KEY_ENV: Record<(typeof PI_PROVIDERS)[number], string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
};

export class PiErrorEvent extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "PiErrorEvent";
    this.detail = detail;
  }
}

export class PiEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiEventError";
  }
}

export function parsePiEvent(line: string): HarnessEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new PiEventError(`Unparseable Pi event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new PiEventError("Pi event is not an object.");
  }

  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "tool_execution_start") {
    const name = typeof record.toolName === "string" && record.toolName ? record.toolName : "tool";
    return { kind: "tool", name, text: `tool: ${name}` };
  }

  if (type === "message_end") {
    const message = record.message;
    if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
    const assistant = message as Record<string, unknown>;
    if (assistant.role !== "assistant") return null;

    const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : "";
    if (stopReason === "error" || stopReason === "aborted") {
      const detail = typeof assistant.errorMessage === "string" && assistant.errorMessage
        ? assistant.errorMessage
        : `Pi stopped before completing: ${stopReason}.`;
      throw new PiErrorEvent(boundTail(detail, 500));
    }

    const text = assistantText(assistant);
    const usage = assistant.usage;
    if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
      const usageRecord = usage as Record<string, unknown>;
      const cost = usageRecord.cost;
      const costTotal =
        cost !== null && typeof cost === "object" && !Array.isArray(cost)
          ? (cost as Record<string, unknown>).total
          : undefined;
      const usageDelta: { inputTokens: number; outputTokens: number; costUsd?: number } = {
        inputTokens:
          tokenCount(usageRecord.input) + tokenCount(usageRecord.cacheRead) + tokenCount(usageRecord.cacheWrite),
        outputTokens: tokenCount(usageRecord.output),
      };
      if (typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal >= 0) {
        usageDelta.costUsd = costTotal;
      }
      return {
        kind: "usage",
        cumulative: false,
        usage: usageDelta,
        text: boundTail(text, 500),
      };
    }

    return text ? { kind: "text", text: boundTail(text, 500) } : null;
  }

  if (type === "agent_settled" && record.aborted === true) {
    throw new PiErrorEvent("Pi agent was aborted.");
  }

  return null;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function piProvider(model: string): (typeof PI_PROVIDERS)[number] {
  return assertSupportedModel("pi", PI_PROVIDERS, model) as (typeof PI_PROVIDERS)[number];
}

function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (content): content is Record<string, unknown> =>
        content !== null &&
        typeof content === "object" &&
        !Array.isArray(content) &&
        content.type === "text" &&
        typeof content.text === "string",
    )
    .map((content) => content.text as string)
    .join("");
}

export class PiHarness implements AgentHarness {
  readonly name = "pi" as const;
  readonly supportedProviders = PI_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = piProvider(model);
    return [PROVIDER_HOSTS[provider] as string];
  }

  configFile(): null {
    return null;
  }

  env(input: CodingTaskInput, _configPath: string | null = null): Record<string, string> {
    const provider = piProvider(input.codingModel);
    return {
      [PI_PROVIDER_KEY_ENV[provider]]: DUMMY_PROVIDER_KEY,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
    };
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    const provider = piProvider(input.codingModel);
    return [
      "pi",
      "--mode",
      "json",
      "--no-session",
      "--provider",
      provider,
      "--model",
      stripProvider(input.codingModel),
      "--",
      input.task,
    ];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parsePiEvent(line);
  }

  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: false,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: true,
      supportsConversationRollback: false,
      execAllowlist: [["pnpm", "test"], ["npm", "test"], ["bun", "test"], ["pnpm", "vitest", "run"], ["npx", "vitest", "run"]],
      supportedRuntimes: ["sandbox"],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash < 0 ? model : model.slice(slash + 1);
}

export const piHarness = new PiHarness();
