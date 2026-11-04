import type React from "react";
import { useEffect, useId, useState } from "react";
import { useOrgConnections } from "./org-connections";

export interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectStarterTask?: (repoUrl: string, task: string, harness: string) => void;
  onOpenInbox?: () => void;
  initialExpandedStep?: string | null;
}

export interface SetupStep {
  id: string;
  title: string;
  category: string;
  required: boolean;
  summary: string;
  detail: string;
  codeSnippet?: string;
  planRef: string;
  docAnchor: string;
}

export const CORE_STEPS = [
  {
    id: "github-token",
    title: "Connect GitHub",
    category: "Integration",
    required: false,
    summary: "For repository tasks, configure access only to the repositories you choose.",
    detail:
      "Configure your fine-grained GitHub PAT or App credentials so Shiba can clone repositories and publish approved pull requests. Container egress is scoped strictly to approved repositories.",
    codeSnippet: `# Store in production Worker secrets:
npx wrangler secret put GITHUB_TOKEN
# Or for local development in .dev.vars:
GITHUB_TOKEN=ghp_yourTokenHere`,
    planRef: "PLAN.md §6 (T6)",
    docAnchor: "5-github-token--scoped-permissions-planmd-6-t6",
  },
  {
    id: "connect-sandbox",
    title: "Connect Sandbox Runner",
    category: "Sandbox",
    required: false,
    summary: "Optional runner configuration. You can also use a configured Cloudflare sandbox or a paired computer.",
    detail:
      "Use this form only for a ComputeSDK runner you operate. Configure its HTTPS endpoint and bearer token, then test before saving. A saved endpoint does not prove that a selected employee task can execute. Cloudflare and paired-computer setup have separate requirements.",
    codeSnippet: `# Example runner sidecar:
SHIBA_COMPUTESDK_PROVIDER=e2b E2B_API_KEY=... SHIBA_COMPUTESDK_RUNNER_TOKEN=secret node scripts/computesdk-runner.mjs`,
    planRef: "PLAN.md §5 (T1, T2)",
    docAnchor: "2-infrastructure-setup-planmd-5-t1t2",
  },
  {
    id: "connect-model",
    title: "Connect Model Keys",
    category: "Models",
    required: false,
    summary: "Optional API-key configuration. Claude Code and Codex also have supported account and local-tool paths in Providers.",
    detail:
      "Use this form when you choose a provider API key. Review Providers for Claude Code and Codex account connections and pair a computer when using an installed local CLI. Availability depends on the selected runtime and account; a saved key or connection is not proof of inference or task readiness. Managed provider credentials stay outside coding containers.",
    codeSnippet: `# Models supported:
Anthropic (x-api-key)
OpenAI (Authorization: Bearer)
Google AI Studio (x-goog-api-key)
xAI (Authorization: Bearer)`,
    planRef: "PLAN.md §5 (T3, T4)",
    docAnchor: "3-ai-gateway--byok-keys-planmd-5--8",
  },
];

export const OPERATOR_STEPS = [
  {
    id: "workers-paid",
    title: "Cloudflare Workers Paid",
    category: "Infrastructure",
    required: false,
    summary: "Review the plan and limits required by the Cloudflare services you deploy.",
    detail:
      "The dashboard cannot infer Cloudflare plan eligibility from a successful HTTP response. Review container provisioning, Durable Object migrations and account limits before deployment.",
    codeSnippet: `// wrangler.jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CodingOrchestrator", "OpenCodeAgent", "Sandbox"] }]`,
    planRef: "PLAN.md §5 (T1)",
    docAnchor: "2-infrastructure-setup-planmd-5-t1t2",
  },
  {
    id: "access-bypass",
    title: "Cloudflare Access & Webhook Bypass",
    category: "Security",
    required: false,
    summary: "Protect the dashboard while exempting Slack and GitHub signature webhooks.",
    detail:
      "Protect your worker with Cloudflare Zero Trust Access. Exempt only the documented signature-verified callback paths. Keep room, canvas, memory and other dashboard reads behind their identity checks.",
    codeSnippet: `REQUIRE_ACCESS=true`,
    planRef: "PLAN.md §6 (T7)",
    docAnchor: "4-cloudflare-access--mandatory-webhook-bypasses-planmd-6--9",
  },
  {
    id: "slack-bot",
    title: "Slack Bot Integration",
    category: "Slack",
    required: false,
    summary: "Enable on-call task approvals directly within Slack channels.",
    detail:
      "Create a Slack App with chat:write, app_mentions:read, and allowlist specific user IDs permitted to approve coding runs.",
    codeSnippet: `SLACK_APPROVERS=U01234567,U09876543`,
    planRef: "PLAN.md §9 (T12)",
    docAnchor: "6-slack-bot-integration-planmd-9-optional",
  },
];

export const ONBOARDING_STEPS: SetupStep[] = [...CORE_STEPS, ...OPERATOR_STEPS];

const STORAGE_KEY = "shiba_onboarding_completed_steps";

interface SetupStatusShape {
  gateway?: { reachable?: string };
  access?: { required?: boolean };
  github?: { token?: boolean };
  slack?: { signingSecret?: boolean; botToken?: boolean; approvers?: number };
}

export async function detectSetupSteps(): Promise<Set<string>> {
  const found = new Set<string>();
  const status = (await fetch("/api/setup/status")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as SetupStatusShape | null;

  if (status !== null && typeof status === "object") {
    if (status.gateway?.reachable === "yes") found.add("connect-model");
    if (status.access?.required) found.add("access-bypass");
    if (status.github?.token) found.add("github-token");
    if (status.slack?.signingSecret && status.slack?.botToken && (status.slack?.approvers ?? 0) > 0)
      found.add("slack-bot");
  }

  // Check org sandbox settings
  try {
    const sandboxRes = (await fetch("/api/org/sandbox").then((r) => (r.ok ? r.json() : null))) as {
      settings?: { runnerUrl?: string; providerId?: string };
    } | null;
    if (sandboxRes?.settings?.runnerUrl || sandboxRes?.settings?.providerId) {
      found.add("connect-sandbox");
    }
  } catch {
    // ignore
  }

  // Check org model keys
  try {
    const keysRes = (await fetch("/api/org/model-keys").then((r) => (r.ok ? r.json() : null))) as {
      keys?: Array<{ configured: boolean }>;
    } | null;
    if (keysRes?.keys?.some((k) => k.configured)) {
      found.add("connect-model");
    }
  } catch {
    // ignore
  }

  return found;
}

export function OnboardingModal({
  isOpen,
  onClose,
  onSelectStarterTask,
  onOpenInbox,
  initialExpandedStep = "github-token",
}: OnboardingModalProps): React.JSX.Element | null {
  const [completedSteps, setCompletedSteps] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === "string" && ONBOARDING_STEPS.some((step) => step.id === id)))] : [];
      }
    } catch {
      // ignore
    }
    return [];
  });

  const [expandedStep, setExpandedStep] = useState<string | null>(initialExpandedStep);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showOperatorSteps, setShowOperatorSteps] = useState(false);
  const [detected, setDetected] = useState<Set<string>>(new Set());
  const [starterHarness, setStarterHarness] = useState("");

  const connections = useOrgConnections();
  const modalTitleId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(completedSteps));
    } catch {
      // ignore
    }
  }, [completedSteps]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    detectSetupSteps()
      .then((found) => {
        if (!cancelled) setDetected(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (connections.sandboxConfigured) {
      setDetected((prev) => new Set([...prev, "connect-sandbox"]));
    }
  }, [connections.sandboxConfigured]);

  useEffect(() => {
    if (connections.modelConfigured) {
      setDetected((prev) => new Set([...prev, "connect-model"]));
    }
  }, [connections.modelConfigured]);

  if (!isOpen) return null;

  const toggleStep = (stepId: string) => {
    setCompletedSteps((prev) =>
      prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId]
    );
  };

  const copySnippet = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const isStepDone = (id: string) => completedSteps.includes(id) || detected.has(id);
  const guideReviewed = CORE_STEPS.every((s) => isStepDone(s.id));

  return (
    <div
      className="fixed inset-0 bg-[var(--overlay)] z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={modalTitleId}
    >
      <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-2xl w-full p-5 sm:p-7 shadow-[var(--sh-overlay)] my-auto text-[var(--fg)] max-h-[90dvh] flex flex-col">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-[var(--border-1)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[var(--radius-button)] bg-[var(--primary-soft)] border border-[var(--primary)]/50 flex items-center justify-center text-xl">
              🚀
            </div>
            <div>
              <h2 id={modalTitleId} className="text-lg font-bold text-[var(--fg)] flex items-center gap-2 text-balance">
                Quick Setup & Onboarding
              </h2>
              <p className="text-xs text-[var(--muted-foreground-2)] mt-0.5 text-pretty">
                Choose the account, runtime and resources your employee needs. These options are not required for every task.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] flex items-center justify-center text-sm font-mono transition-colors shrink-0"
            aria-label="Close onboarding modal"
          >
            ✕
          </button>
        </div>

        {/* 3 Core Steps Checklist */}
        <div className="py-4 flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
          <section aria-label="Setup paths" className="border border-[var(--border-1)] bg-[var(--bg)] p-3 text-xs">
            <p className="text-[var(--muted-foreground-2)]">Start with an optional employee role and a draft task. Review actual connection status and supported runtimes before approving work.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {[["/custom-agents/", "Choose employees"], ["/providers/", "Claude and Codex providers"], ["/remote/", "Pair a computer"], ["/integrations/", "Apps and MCP servers"], ["/skills/", "Review skills"]].map(([href, label]) => <a key={href} href={href} className="inline-flex min-h-11 items-center border border-[var(--border-1)] px-3 text-[var(--primary)] hover:bg-[var(--secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">{label}</a>)}
            </div>
          </section>
          {CORE_STEPS.map((step, idx) => {
            const isDone = isStepDone(step.id);
            const isExpanded = expandedStep === step.id;

            return (
              <div
                key={step.id}
                className={`border rounded-[var(--radius-button)] transition-colors ${
                  isDone
                    ? "border-[var(--primary)]/30 bg-[var(--primary)]/5"
                    : isExpanded
                    ? "border-[var(--border-2)] bg-[var(--panel)]"
                    : "border-[var(--border-1)] bg-[var(--bg)] hover:border-[var(--border-2)]"
                }`}
              >
                <div className="p-3 sm:p-3.5 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => toggleStep(step.id)}
                      className={`w-11 h-11 rounded-[var(--radius-button)] mt-0.5 flex items-center justify-center border transition-colors shrink-0 ${
                        isDone
                          ? "bg-[var(--primary)] border-[var(--primary)] text-white font-bold text-xs"
                          : "border-[var(--border-2)] bg-[var(--card)] hover:border-[var(--primary)]"
                      }`}
                      role="checkbox"
                      aria-checked={completedSteps.includes(step.id)}
                      aria-label={`Mark ${step.title} as ${completedSteps.includes(step.id) ? "unreviewed" : "reviewed"}`}
                    >
                      {completedSteps.includes(step.id) ? "✓" : null}
                    </button>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={`Toggle details for step ${idx + 1}: ${step.title}`}
                      className="cursor-pointer min-w-0 text-left"
                      onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-[var(--muted-foreground-2)]">Step {idx + 1}</span>
                        <span className={`text-xs font-semibold ${isDone ? "text-[var(--primary)] line-through opacity-80" : "text-[var(--fg)]"}`}>
                          {step.title}
                        </span>
                        {isDone ? (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-[var(--radius-button)] bg-[var(--primary-soft)] border border-[var(--primary)]/15 text-[var(--primary)]">
                            {detected.has(step.id) ? "configuration found" : "reviewed"}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-[var(--muted-foreground-2)] mt-1 leading-relaxed">
                        {step.summary}
                      </p>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                    className="text-xs text-[var(--muted-foreground-2)] hover:text-[var(--fg)] font-mono px-2 py-1 rounded-[var(--radius-button)] hover:bg-[var(--secondary)] transition-colors shrink-0"
                  >
                    {isExpanded ? "▲ Hide" : "▼ Setup"}
                  </button>
                </div>

                {isExpanded ? (
                  <div className="px-3 sm:px-4 pb-3.5 pt-1 border-t border-[var(--border-1)] text-xs text-[var(--muted-foreground-2)] flex flex-col gap-2.5">
                    <p className="leading-relaxed text-[var(--fg)]">{step.detail}</p>

                    {step.id === "connect-sandbox" ? (
                      <div className="space-y-2.5 p-3 rounded-[var(--radius-button)] bg-[var(--card)] border border-[var(--border-1)]">
                        <div>
                          <label className="text-[11px] font-semibold text-[var(--fg)] block mb-1">
                            Runner URL (HTTPS only):
                          </label>
                          <input
                            type="text"
                            value={connections.runnerUrl}
                            onChange={(e) => connections.setRunnerUrl(e.target.value)}
                            placeholder="https://runner.your-org.com"
                            className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--fg)]"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[11px] font-semibold text-[var(--fg)] block mb-1">
                              Bearer Token:
                            </label>
                            {connections.sandboxConfigured && !connections.runnerToken ? (
                              <div className="text-[11px] font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--primary)]">
                                Configured (ends with …{connections.sandboxLast4 ?? "••••"})
                              </div>
                            ) : (
                              <input
                                type="password"
                                value={connections.runnerToken}
                                onChange={(e) => connections.setRunnerToken(e.target.value)}
                                placeholder="Bearer token"
                                className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--fg)]"
                              />
                            )}
                          </div>
                          <div>
                            <label className="text-[11px] font-semibold text-[var(--fg)] block mb-1">
                              Backend:
                            </label>
                            <select
                              value={connections.runnerBackend}
                              onChange={(e) => connections.setRunnerBackend(e.target.value as any)}
                              className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--fg)]"
                            >
                              <option value="e2b">E2B</option>
                              <option value="modal">Modal</option>
                              <option value="daytona">Daytona</option>
                            </select>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 pt-1 flex-wrap">
                          <button
                            type="button"
                            onClick={() => void connections.testSandbox()}
                            disabled={connections.testingSandbox || connections.savingSandbox}
                            className="text-xs font-semibold px-3 py-1 rounded-[var(--radius-button)] bg-[var(--secondary)] hover:bg-[var(--secondary)]/80 text-[var(--fg)] border border-[var(--border-1)]"
                          >
                            {connections.testingSandbox ? "Testing..." : "Test Runner"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void connections.saveSandbox()}
                            disabled={!connections.canSaveSandbox || connections.savingSandbox}
                            className={`text-xs font-semibold px-3 py-1 rounded-[var(--radius-button)] border transition-colors ${
                              connections.canSaveSandbox
                                ? "bg-[var(--primary)] text-white hover:bg-[var(--primary-soft-hover)] border-transparent"
                                : "bg-[var(--card)] text-[var(--muted-foreground-2)] border-[var(--border-1)] cursor-not-allowed opacity-60"
                            }`}
                          >
                            {connections.savingSandbox ? "Saving..." : "Save Runner"}
                          </button>
                          {connections.sandboxTestResult ? (
                            <span className={`text-[11px] font-mono ${connections.sandboxTestResult.ok ? "text-[var(--primary)]" : "text-[var(--destructive)]"}`}>
                              {connections.sandboxTestResult.ok ? "✓ " : "✗ "} {connections.sandboxTestResult.message}
                            </span>
                          ) : null}
                          {connections.sandboxSaveError ? (
                            <span className="text-[11px] font-mono text-[var(--destructive)] block w-full mt-1">
                              ✗ {connections.sandboxSaveError}
                            </span>
                          ) : null}
                          {connections.sandboxConfigured && !connections.sandboxSaveError ? (
                            <span className="text-[11px] font-mono text-[var(--primary)]">
                              ✓ Saved and configured
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {step.id === "connect-model" ? (
                      <div className="space-y-2.5 p-3 rounded-[var(--radius-button)] bg-[var(--card)] border border-[var(--border-1)]">
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="text-[11px] font-semibold text-[var(--fg)] block mb-1">
                              Provider:
                            </label>
                            <select
                              value={connections.modelProvider}
                              onChange={(e) => connections.setModelProvider(e.target.value as any)}
                              className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--fg)]"
                            >
                              <option value="anthropic">Anthropic</option>
                              <option value="openai">OpenAI</option>
                              <option value="google">Google AI Studio</option>
                              <option value="xai">xAI</option>
                            </select>
                          </div>
                          <div className="col-span-2">
                            <label className="text-[11px] font-semibold text-[var(--fg)] block mb-1">
                              API Key:
                            </label>
                            {connections.modelConfigured && !connections.modelApiKey ? (
                              <div className="text-[11px] font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--primary)]">
                                Configured (ends with …{connections.modelLast4 ?? "••••"})
                              </div>
                            ) : (
                              <input
                                type="password"
                                value={connections.modelApiKey}
                                onChange={(e) => connections.setModelApiKey(e.target.value)}
                                placeholder="sk-..."
                                className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] text-[var(--fg)]"
                              />
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 pt-1 flex-wrap">
                          <button
                            type="button"
                            onClick={() => void connections.testModel()}
                            disabled={connections.testingModel || connections.savingModel}
                            className="text-xs font-semibold px-3 py-1 rounded-[var(--radius-button)] bg-[var(--secondary)] hover:bg-[var(--secondary)]/80 text-[var(--fg)] border border-[var(--border-1)]"
                          >
                            {connections.testingModel ? "Testing..." : "Test Key"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void connections.saveModel()}
                            disabled={!connections.canSaveModel || connections.savingModel}
                            className={`text-xs font-semibold px-3 py-1 rounded-[var(--radius-button)] border transition-colors ${
                              connections.canSaveModel
                                ? "bg-[var(--primary)] text-white hover:bg-[var(--primary-soft-hover)] border-transparent"
                                : "bg-[var(--card)] text-[var(--muted-foreground-2)] border-[var(--border-1)] cursor-not-allowed opacity-60"
                            }`}
                          >
                            {connections.savingModel ? "Saving..." : "Save Key"}
                          </button>
                          {connections.modelTestResult ? (
                            <span className={`text-[11px] font-mono ${connections.modelTestResult.ok ? "text-[var(--primary)]" : "text-[var(--destructive)]"}`}>
                              {connections.modelTestResult.ok ? "✓ " : "✗ "} {connections.modelTestResult.message}
                            </span>
                          ) : null}
                          {connections.modelSaveError ? (
                            <span className="text-[11px] font-mono text-[var(--destructive)] block w-full mt-1">
                              ✗ {connections.modelSaveError}
                            </span>
                          ) : null}
                          {connections.modelConfigured && !connections.modelSaveError ? (
                            <span className="text-[11px] font-mono text-[var(--primary)]">
                              ✓ Saved and configured
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {step.codeSnippet ? (
                      <div className="relative mt-1">
                        <pre className="font-mono text-[11px] text-[var(--fg)] bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] overflow-x-auto whitespace-pre leading-normal">
                          {step.codeSnippet}
                        </pre>
                        <button
                          type="button"
                          onClick={() => copySnippet(step.id, step.codeSnippet!)}
                          className="absolute top-2 right-2 px-2 py-1 rounded-[var(--radius-button)] bg-[var(--panel)] hover:bg-[var(--secondary)] border border-[var(--border-2)] text-[10px] font-mono text-[var(--muted-foreground-2)] hover:text-[var(--fg)] transition-colors"
                        >
                          {copiedId === step.id ? "✓ Copied" : "Copy"}
                        </button>
                      </div>
                    ) : null}

                    <div className="pt-1 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => toggleStep(step.id)}
                        className={`text-xs px-3 py-1.5 rounded-[var(--radius-button)] border font-medium transition-colors ${
                          isDone
                            ? "border-[var(--border-2)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
                            : "border-[var(--primary)]/50 bg-[var(--primary-soft)] text-[var(--primary)] hover:bg-[var(--primary-soft)]"
                        }`}
                      >
                        {completedSteps.includes(step.id) ? "Mark as unreviewed" : "Mark as reviewed"}
                      </button>
                      <a
                        href={`/docs/onboarding/#${step.docAnchor}`}
                        className="text-[11px] text-[var(--primary)] hover:underline font-mono"
                      >
                        Learn more →
                      </a>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {guideReviewed ? (
            <div className="mt-2 text-xs bg-[var(--primary-soft)] border border-[var(--primary)]/40 text-[var(--primary)] p-3 rounded-[var(--radius-button)] flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="block text-[var(--fg)] font-semibold">Setup options reviewed</strong>
                <span className="text-[var(--muted-foreground-2)]">You can draft a task. Its selected connection, runtime, resources and human approval are checked separately.</span>
              </div>
              <label className="flex min-w-0 flex-col gap-1 text-[var(--fg)]">Starter task coding tool<select aria-label="Starter task coding tool" value={starterHarness} onChange={(event) => setStarterHarness(event.target.value)} className="min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs"><option value="">Choose a tool</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label>
              <button
                type="button"
                disabled={!starterHarness || !onSelectStarterTask}
                onClick={() => {
                  onSelectStarterTask?.(
                    "https://github.com/cloudflare/ai-chat",
                    "Add unit tests for error handling and verify the test suite passes.",
                    starterHarness
                  );
                  onClose();
                }}
                className="min-h-11 bg-[var(--primary)] text-[var(--primary-text)] font-semibold text-[11px] px-3.5 py-1.5 rounded-[var(--radius-button)] hover:bg-[var(--primary-soft-hover)] transition-colors shadow-[var(--sh-card)] shrink-0 disabled:opacity-40"
              >
                Draft Starter Task →
              </button>
            </div>
          ) : null}

          {/* Operator Setup Collapsed Section */}
          <div className="mt-3 pt-3 border-t border-[var(--border-1)]">
            <button
              type="button"
              onClick={() => setShowOperatorSteps(!showOperatorSteps)}
              className="w-full flex items-center justify-between text-xs font-semibold text-[var(--muted-foreground-2)] hover:text-[var(--fg)] p-2 rounded-[var(--radius-button)] hover:bg-[var(--secondary)]/50 transition-colors"
            >
              <span>Operator & Self-Hosting Setup (Workers Paid, Access, Slack)</span>
              <span className="font-mono text-[11px]">{showOperatorSteps ? "▲ Hide" : "▼ Show"}</span>
            </button>

            {showOperatorSteps ? (
              <div className="mt-2 space-y-2">
                {OPERATOR_STEPS.map((step) => {
                  const isDone = isStepDone(step.id);
                  return (
                    <div
                      key={step.id}
                      className="p-2.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-xs flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-[var(--fg)] flex items-center gap-2">
                          <span>{step.title}</span>
                          {isDone ? (
                            <span className="text-[10px] text-[var(--primary)] font-mono">{detected.has(step.id) ? "Configuration found" : "Reviewed"}</span>
                          ) : null}
                        </div>
                        <p className="text-[11px] text-[var(--muted-foreground-2)] mt-0.5">{step.summary}</p>
                      </div>
                      <a
                        href={`/docs/onboarding/#${step.docAnchor}`}
                        className="text-[11px] font-mono text-[var(--primary)] hover:underline shrink-0"
                      >
                        Learn more about {step.title}
                      </a>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="pt-3.5 border-t border-[var(--border-1)] flex items-center justify-between gap-3 shrink-0 flex-wrap">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                onOpenInbox?.();
                onClose();
              }}
              className="text-xs text-[var(--primary)] hover:underline font-mono"
            >
              Open Inbox Setup →
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-[var(--radius-button)] text-xs font-medium text-[var(--fg)] bg-[var(--card)] border border-[var(--border-1)] hover:bg-[var(--secondary)] transition-colors"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
}
