/**
 * Reserved native cloud Claude lane. No auth volume is provisioned, and
 * mounting native login credentials would violate container credential isolation.
 * Keep direct execution unavailable as well as dashboard intake.
 */
import type { HarnessTextSanitizer } from "./event-sanitizer.js";
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import {
  assertSupportedModel,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessConfigFile,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import { parseClaudeCodeEvent } from "./claude-code.js";

export const CLAUDE_LOGIN_PROVIDERS = ["anthropic-subscription"] as const;

export interface ClaudeLoginVolumeMount {
  userId: string;
  hostPath: string;
  containerPath: string;
}

/** A derived pathname is not a provisioned or authorized credential volume. */
export function claudeLoginVolumeForUser(_userId: string): ClaudeLoginVolumeMount | null {
  return null;
}

export function claudeLoginConfigDir(input: Pick<CodingTaskInput, "initiatorUserId">): string {
  const userId = input.initiatorUserId ?? "anonymous";
  const mount = claudeLoginVolumeForUser(userId);
  return mount?.containerPath ?? `/root/.shiba/claude-login/unprovisioned`;
}

export class ClaudeLoginHarness implements AgentHarness {
  readonly name = "claude-login" as const;
  readonly supportedProviders = CLAUDE_LOGIN_PROVIDERS;

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return ["api.anthropic.com"];
  }

  configFile(_input: CodingTaskInput): HarnessConfigFile[] {
    return [];
  }

  env(input: CodingTaskInput): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    throw new Error("Native cloud Claude login is unavailable; choose API Claude Code or paired local Claude Code explicitly.");
  }

  buildArgv(_input: CodingTaskInput, _workdir: string): string[] {
    throw new Error("Native cloud Claude login is unavailable; native credentials must not enter a sandbox.");
  }

  parseEvent(line: string, sanitize?: HarnessTextSanitizer): HarnessEvent | null {
    return parseClaudeCodeEvent(line, sanitize);
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
      execAllowlist: [["pnpm", "test"], ["npm", "test"], ["bun", "test"]],
      supportedRuntimes: [],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    if (!input.initiatorUserId) {
      return { ok: false, reason: "claude-login requires a signed-in user (initiatorUserId)." };
    }
    if (claudeLoginVolumeForUser(input.initiatorUserId) === null) {
      return {
        ok: false,
        reason:
          "Per-user Claude config volumes are not available on this deployment yet (#119/#123). Native credentials must not enter a sandbox. Choose API claude-code or paired local Claude Code explicitly.",
      };
    }
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

export const claudeLoginHarness = new ClaudeLoginHarness();
