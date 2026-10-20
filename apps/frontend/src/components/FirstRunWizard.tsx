/**
 * FirstRunWizard — the post-signup onboarding flow. Three steps:
 *   1. Connect GitHub  — configure repository access for tasks and PRs.
 *   2. Connect Sandbox — configure custom ComputeSDK runner URL, token, and backend with test ping.
 *   3. Connect Model   — configure provider API key with live probe.
 * Collapses operator-only infra behind an expandable section.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { AppNavView } from "./AppNavRail";
import { ToneChip } from "./ToneChip";
import { useSetupStatus } from "../live-status";

export const ONBOARDING_STORAGE_KEY = "shiba-onboarding-v1";

const STEPS = [
  { id: "github", title: "Connect GitHub", blurb: "Configure repository permissions for tasks and pull requests" },
  { id: "sandbox", title: "Connect Sandbox", blurb: "Configure your ComputeSDK runner (e2b, modal, or daytona)" },
  { id: "model", title: "Connect Model", blurb: "Provide API keys for Anthropic, OpenAI, Google, or xAI" },
] as const;

function WizardShell({
  step,
  onClose,
  children,
  footer,
}: {
  step: number;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}): JSX.Element {
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome setup"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-overlay)] border border-[var(--border-1)] bg-[var(--card)] shadow-[4px_4px_0_var(--sh-card)]"
      >
        <div className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--primary)]">
                Welcome — {step + 1} of {STEPS.length}
              </div>
              <h2 className="mt-0.5 text-base font-semibold text-[var(--text)]">
                {current.title}
              </h2>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{current.blurb}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close setup"
              className="size-8 shrink-0 rounded-[var(--radius-button)] text-[var(--muted-foreground-2)] hover:bg-[var(--border-1)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex gap-1.5">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 flex-1 rounded-full ${i <= step ? "bg-[var(--primary)]" : "bg-[var(--border-1)]"}`}
              />
            ))}
          </div>
        </div>
        <div className="min-h-0 max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
        <div className="shrink-0 border-t border-[var(--border-1)] px-5 py-4">{footer}</div>
      </div>
    </div>
  );
}

function Footer({
  step,
  setStep,
  onFinish,
}: {
  step: number;
  setStep: (n: number) => void;
  onFinish: () => void;
}): JSX.Element {
  const last = step === STEPS.length - 1;
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onFinish}
        className="font-mono text-[11px] text-[var(--muted-foreground-2)] hover:text-[var(--text)]"
      >
        Skip setup
      </button>
      <div className="flex items-center gap-2">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="rounded-[var(--radius-overlay)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-1.5 font-mono text-[11px] font-medium text-[var(--muted-foreground-2)] hover:border-[var(--border-2)] hover:text-[var(--text)]"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => (last ? onFinish() : setStep(step + 1))}
          className="rounded-[var(--radius-button)] bg-[var(--primary)] px-4 py-1.5 font-mono text-[11px] font-semibold text-[var(--primary-text)] shadow-[2px_2px_0_var(--sh-card)] transition-colors hover:bg-[var(--primary)] active:translate-y-px"
        >
          {last ? "Finish" : "Next"}
        </button>
      </div>
    </div>
  );
}

export function FirstRunWizard({
  open,
  onClose,
  onNavigate,
  onOpenModels,
  onOpenChecklist,
  onSelectStarterTask,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate?: (view: AppNavView) => void;
  onOpenModels?: () => void;
  onOpenChecklist?: () => void;
  onSelectStarterTask?: (repoUrl: string, task: string, harness: string) => void;
}): JSX.Element | null {
  const [step, setStep] = useState(0);
  const setup = useSetupStatus();

  // Sandbox connection state
  const [runnerUrl, setRunnerUrl] = useState("");
  const [runnerToken, setRunnerToken] = useState("");
  const [runnerBackend, setRunnerBackend] = useState("e2b");
  const [testingSandbox, setTestingSandbox] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Model key connection state
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [testingModel, setTestingModel] = useState(false);
  const [modelResult, setModelResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Operator section collapse state
  const [showOperatorSection, setShowOperatorSection] = useState(false);

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const githubConfigured = Boolean(status?.github.token || status?.github.app);

  if (!open) return null;

  const finish = () => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");
    } catch {
      // private mode
    }
    onClose();
  };

  const handleTestSandbox = async () => {
    setTestingSandbox(true);
    setSandboxResult(null);
    try {
      if (runnerUrl && runnerToken) {
        await fetch("/api/org/sandbox", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "computesdk",
            computesdkBackend: runnerBackend,
            runnerUrl,
            runnerToken,
          }),
        });
      }
      const res = await fetch("/api/org/sandbox/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runnerUrl && runnerToken ? { runnerUrl, runnerToken } : {}),
      });
      const data = (await res.json()) as { ok: boolean; message: string; error?: string };
      setSandboxResult({ ok: data.ok, message: data.message || data.error || (data.ok ? "Connected" : "Failed") });
    } catch (e) {
      setSandboxResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
    } finally {
      setTestingSandbox(false);
    }
  };

  const handleTestModel = async () => {
    setTestingModel(true);
    setModelResult(null);
    try {
      if (apiKey) {
        await fetch(`/api/org/model-keys/${provider}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
      }
      const res = await fetch("/api/org/model-keys/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}) }),
      });
      const data = (await res.json()) as { ok: boolean; message: string; error?: string };
      setModelResult({ ok: data.ok, message: data.message || data.error || (data.ok ? "Connected" : "Failed") });
    } catch (e) {
      setModelResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
    } finally {
      setTestingModel(false);
    }
  };

  return (
    <WizardShell
      step={step}
      onClose={finish}
      footer={
        <>
          <Footer step={step} setStep={setStep} onFinish={finish} />
          {onOpenChecklist ? (
            <p className="mt-3 border-t border-[var(--border-1)]/60 pt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenChecklist();
                }}
                className="font-mono text-[10px] text-[var(--muted-foreground-2)] hover:text-[var(--text)]"
              >
                Open deployment checklist →
              </button>
            </p>
          ) : null}
        </>
      }
    >
      {/* Step 0: Connect GitHub */}
      {step === 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] p-3">
            <div>
              <div className="text-[13px] font-semibold text-[var(--text)]">GitHub Integration</div>
              <div className="text-[11px] text-[var(--muted-foreground-2)]">
                Required for repository checkouts and pull requests
              </div>
            </div>
            <ToneChip
              tone={githubConfigured ? "ok" : "pending"}
              label={githubConfigured ? "Configured" : "Needs Token"}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            Configure a fine-grained GitHub PAT or App token with repo read/write permissions via `GITHUB_TOKEN` secret. Egress is strictly scoped to approved repositories.
          </p>
        </div>
      ) : null}

      {/* Step 1: Connect Sandbox */}
      {step === 1 ? (
        <div className="space-y-3">
          <div className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] p-3 space-y-2">
            <div className="text-[13px] font-semibold text-[var(--text)]">ComputeSDK Sandbox Runner</div>
            <p className="text-[11px] text-[var(--muted-foreground-2)]">
              Paste your runner sidecar URL and bearer token (E2B, Modal, or Daytona). Encrypted at rest.
            </p>
            <div>
              <label className="text-[11px] font-medium text-[var(--text)] block mb-1">Runner URL:</label>
              <input
                type="text"
                value={runnerUrl}
                onChange={(e) => setRunnerUrl(e.target.value)}
                placeholder="https://runner.your-domain.com"
                className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--text)]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-medium text-[var(--text)] block mb-1">Token:</label>
                <input
                  type="password"
                  value={runnerToken}
                  onChange={(e) => setRunnerToken(e.target.value)}
                  placeholder="Bearer token"
                  className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--text)]"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-[var(--text)] block mb-1">Backend:</label>
                <select
                  value={runnerBackend}
                  onChange={(e) => setRunnerBackend(e.target.value)}
                  className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--text)]"
                >
                  <option value="e2b">E2B</option>
                  <option value="modal">Modal</option>
                  <option value="daytona">Daytona</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleTestSandbox}
                disabled={testingSandbox}
                className="rounded-[var(--radius-button)] bg-[var(--secondary)] px-3 py-1 font-mono text-[11px] font-semibold text-[var(--text)] border border-[var(--border-1)] hover:bg-[var(--secondary)]/80"
              >
                {testingSandbox ? "Testing…" : "Save & Test"}
              </button>
              {sandboxResult ? (
                <span className={`text-[11px] font-mono ${sandboxResult.ok ? "text-[var(--primary)]" : "text-[var(--destructive)]"}`}>
                  {sandboxResult.ok ? "✓ " : "✗ "} {sandboxResult.message}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Step 2: Connect Model */}
      {step === 2 ? (
        <div className="space-y-3">
          <div className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] p-3 space-y-2">
            <div className="text-[13px] font-semibold text-[var(--text)]">Provider Model Keys</div>
            <p className="text-[11px] text-[var(--muted-foreground-2)]">
              Paste your raw provider API key. Egress proxy attaches the required headers per request.
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[11px] font-medium text-[var(--text)] block mb-1">Provider:</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--text)]"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                  <option value="xai">xAI</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[11px] font-medium text-[var(--text)] block mb-1">API Key:</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full text-xs font-mono p-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--text)]"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleTestModel}
                disabled={testingModel}
                className="rounded-[var(--radius-button)] bg-[var(--secondary)] px-3 py-1 font-mono text-[11px] font-semibold text-[var(--text)] border border-[var(--border-1)] hover:bg-[var(--secondary)]/80"
              >
                {testingModel ? "Testing…" : "Save & Test"}
              </button>
              {modelResult ? (
                <span className={`text-[11px] font-mono ${modelResult.ok ? "text-[var(--primary)]" : "text-[var(--destructive)]"}`}>
                  {modelResult.ok ? "✓ " : "✗ "} {modelResult.message}
                </span>
              ) : null}
            </div>
          </div>

          {onSelectStarterTask ? (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => {
                  finish();
                  onSelectStarterTask(
                    "https://github.com/cloudflare/ai-chat",
                    "Add unit tests for error handling and verify the test suite passes.",
                    "opencode"
                  );
                }}
                className="w-full rounded-[var(--radius-button)] bg-[var(--primary-soft)] border border-[var(--primary)]/40 p-2.5 text-center text-xs font-semibold text-[var(--primary)] hover:bg-[var(--primary-soft-hover)] transition-colors"
              >
                🚀 Ready! Launch Starter Coding Task →
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Operator Setup Collapsed Section */}
      <div className="mt-4 border-t border-[var(--border-1)]/60 pt-3">
        <button
          type="button"
          onClick={() => setShowOperatorSection(!showOperatorSection)}
          className="flex w-full items-center justify-between text-[11px] font-medium text-[var(--muted-foreground-2)] hover:text-[var(--text)]"
        >
          <span>Operator setup (Workers Paid, Access bypass, Slack)</span>
          <span className="font-mono text-[10px]">{showOperatorSection ? "▲" : "▼"}</span>
        </button>
        {showOperatorSection ? (
          <div className="mt-2 space-y-1.5 text-[11px] text-[var(--muted-foreground-2)] border-l-2 border-[var(--border-1)] pl-2.5">
            <div>• <strong>Workers Paid:</strong> Required for Durable Object SQLite storage and container sandbox.</div>
            <div>• <strong>Access Bypass:</strong> Add webhook bypass rules for /api/slack/* and /api/github/webhook.</div>
            <div>• <strong>Slack:</strong> Add SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET for chat approval cards.</div>
          </div>
        ) : null}
      </div>
    </WizardShell>
  );
}
