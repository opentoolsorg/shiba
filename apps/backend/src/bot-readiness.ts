/**
 * Read-only launch readiness for a saved bot: the same preflight a queued run
 * hits, evaluated before the user writes a task so problems surface with a fix
 * instead of failing at send. It never mints an approval or starts work.
 */
import type { CustomAgentRecord, ExecutionTarget } from "@shiba/shared";
import { verifyStandinEnabled } from "@shiba/shared";
import type { Env } from "./env.js";
import { isGitHubPublishConfigured } from "./github-auth.js";
import { HARNESS_DEFAULT_MODELS, HARNESS_MODEL_ENV, resolveHarness } from "./harness/index.js";
import { readModelConfig, resolveCodingRoute } from "./model-policy.js";
import { assertRunPreflight } from "./run-preflight.js";

export type BotReadinessFixView = "providers" | "settings" | "custom-agents";

export interface BotReadinessProblem {
  id: string;
  severity: "error" | "warn";
  message: string;
  fix: { label: string; view: BotReadinessFixView };
}

export interface BotReadinessReport {
  ready: boolean;
  target: { kind: "repository"; repoUrl: string } | { kind: "artifact-workspace"; expectedDeliverables: string[] };
  harness: string;
  model: string;
  connectionId: string | null;
  /** True when this deployment runs the verify-shiba stand-in instead of real execution. */
  synthetic: boolean;
  problems: BotReadinessProblem[];
}

export class BotReadinessCheck {
  private readonly problems: BotReadinessProblem[] = [];

  constructor(
    private readonly env: Env,
    private readonly orgId: string,
    private readonly agent: CustomAgentRecord,
  ) {}

  async run(): Promise<BotReadinessReport> {
    const config = this.agent.config;
    const target = this.target();
    const model = this.model();
    let connectionId = config.connectionId ?? null;
    const harnessOk = this.check("harness", () => resolveHarness(config.harness, this.env));
    if (harnessOk) {
      const snapshot = await readModelConfig(this.env);
      try {
        const route = resolveCodingRoute(snapshot, { connectionId, model, harness: config.harness });
        connectionId = route.connectionId;
        await assertRunPreflight(this.env, {
          harness: config.harness,
          codingModel: model,
          route,
          ...(target.kind === "repository" ? { repoUrl: target.repoUrl } : {}),
          executionTarget: this.executionTarget(target),
          sandboxProvider: config.sandboxProvider,
          orgId: this.orgId,
        }, snapshot);
      } catch (error) {
        this.problems.push(BotReadinessCheck.classify(error instanceof Error ? error.message : String(error)));
      }
    }
    if (target.kind === "repository" && !isGitHubPublishConfigured(this.env)) {
      this.problems.push({
        id: "github.credentials",
        severity: "warn",
        message: "No GitHub credential is configured, so the default repository cannot be cloned.",
        fix: { label: "Add a GitHub token or App", view: "settings" },
      });
    }
    return {
      ready: !this.problems.some((problem) => problem.severity === "error"),
      target,
      harness: config.harness,
      model,
      connectionId,
      synthetic: verifyStandinEnabled(this.env),
      problems: this.problems,
    };
  }

  /** Maps preflight messages onto the dashboard view that fixes them. */
  static classify(message: string): BotReadinessProblem {
    if (message.includes("AI_GATEWAY_TOKEN")) {
      return { id: "gateway.token", severity: "error", message, fix: { label: "Connect a model or add the gateway token", view: "providers" } };
    }
    if (/model connection/i.test(message)) {
      return { id: "model.connection", severity: "error", message, fix: { label: "Test or pick a model connection", view: "providers" } };
    }
    if (/secret|missing/i.test(message)) {
      return { id: "harness.secret", severity: "error", message, fix: { label: "Open setup", view: "settings" } };
    }
    if (/sandbox/i.test(message)) {
      return { id: "sandbox", severity: "error", message, fix: { label: "Choose a sandbox provider", view: "settings" } };
    }
    return { id: "preflight", severity: "error", message, fix: { label: "Edit the bot", view: "custom-agents" } };
  }

  private check(id: string, probe: () => unknown): boolean {
    try {
      probe();
      return true;
    } catch (error) {
      this.problems.push({
        id,
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        fix: { label: "Edit the bot", view: "custom-agents" },
      });
      return false;
    }
  }

  private target(): BotReadinessReport["target"] {
    const repoUrl = this.agent.config.defaultRepoUrl?.trim();
    if (repoUrl) return { kind: "repository", repoUrl };
    const configured = this.agent.config.expectedDeliverables ?? [];
    return { kind: "artifact-workspace", expectedDeliverables: configured.length ? [...configured] : ["deliverables/brief.md"] };
  }

  private executionTarget(target: BotReadinessReport["target"]): ExecutionTarget {
    return target.kind === "repository"
      ? { kind: "repository", repoUrl: target.repoUrl, baseBranch: "main" }
      : { kind: "artifact-workspace", expectedDeliverables: target.expectedDeliverables };
  }

  private model(): string {
    const config = this.agent.config;
    if (config.codingModel?.trim()) return config.codingModel.trim();
    const modelVar = HARNESS_MODEL_ENV[config.harness as keyof typeof HARNESS_MODEL_ENV];
    const deployment = modelVar !== undefined ? this.env[modelVar]?.trim() : undefined;
    return deployment || HARNESS_DEFAULT_MODELS[config.harness] || "";
  }
}
