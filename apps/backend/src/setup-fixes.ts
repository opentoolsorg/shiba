/**
 * One-click setup fixes. Apply actions that can persist without a secret
 * do so; everything else returns the next command so the operator is never
 * stuck on a finding with no way forward.
 */
import type { Env } from "./env.js";
import { setOrgSandboxProvider } from "./org-sandbox-store.js";

export interface DoctorFixAction {
  id: string;
  label: string;
  kind: "apply" | "guide";
}

const FIXES: Record<string, DoctorFixAction> = {
  "sandbox.provider": { id: "sandbox.use-cloudflare", label: "Use the Cloudflare sandbox", kind: "apply" },
  "sandbox.egress": { id: "sandbox.use-cloudflare", label: "Switch to the Cloudflare sandbox", kind: "apply" },
  "sandbox.computesdk.runner": {
    id: "sandbox.use-cloudflare",
    label: "Use the Cloudflare sandbox instead",
    kind: "apply",
  },
  "containers.binding": {
    id: "sandbox.without-docker",
    label: "Continue without local containers",
    kind: "guide",
  },
  "github.credentials": { id: "guide.github", label: "Add a GitHub token or GitHub App", kind: "guide" },
  "github.token": { id: "guide.github", label: "Replace the GitHub token", kind: "guide" },
  "github.scopes": { id: "guide.github", label: "Regenerate the GitHub token with repo access", kind: "guide" },
  "github.app": { id: "guide.github", label: "Check the GitHub App installation", kind: "guide" },
  "gateway.token": { id: "guide.model", label: "Add a model connection or gateway token", kind: "guide" },
  "gateway.reachable": { id: "guide.model", label: "Check the AI Gateway token", kind: "guide" },
};

const ROLE_FIX: DoctorFixAction = {
  id: "guide.model",
  label: "Connect a model (BYOM, ChatGPT, or an API key alias)",
  kind: "guide",
};

const APPLY_PROVIDERS: Record<string, string> = {
  "sandbox.use-cloudflare": "cloudflare",
  "sandbox.use-docker-local": "docker-local",
  "sandbox.use-computesdk": "computesdk",
  "sandbox.use-e2b": "e2b",
};

const GUIDES: Record<string, { userMessage: string; command: string }> = {
  "sandbox.without-docker": {
    userMessage: "Local dev can continue without containers. Sandbox runs stay off until Docker is up.",
    command: "pnpm shiba setup fix sandbox.without-docker",
  },
  "guide.github": {
    userMessage: "Add GITHUB_TOKEN or GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID to apps/backend/.dev.vars, then re-run pnpm shiba doctor.",
    command: "pnpm shiba setup",
  },
  "guide.model": {
    userMessage:
      "Connect a model: BYOM (OpenAI-compatible base URL + AI Gateway BYOK alias), Sign in with ChatGPT (SHIBA_CODEX_SUBSCRIPTION=1), or a provider API key alias. Then pnpm shiba doctor.",
    command: "pnpm shiba setup",
  },
  "guide.test-repo": {
    userMessage: "Optional: set a test repository with pnpm shiba setup (step testRepo) or export SHIBA_TEST_REPO.",
    command: "pnpm shiba setup",
  },
};

export function fixActionForFinding(id: string): DoctorFixAction | undefined {
  if (FIXES[id]) return FIXES[id];
  if (id.startsWith("role.") || id.startsWith("harness.")) return ROLE_FIX;
  return undefined;
}

export function attachDoctorFixes<T extends { id: string; severity: string }>(
  findings: T[],
): Array<T & { fixAction?: DoctorFixAction }> {
  return findings.map((finding) => {
    if (finding.severity === "ok") return finding;
    const fixAction = fixActionForFinding(finding.id);
    return fixAction ? { ...finding, fixAction } : finding;
  });
}

export function setupWizardCatalog() {
  return {
    steps: [
      {
        id: "github",
        title: "GitHub",
        choices: [
          { id: "token", label: "Personal access token" },
          { id: "app", label: "GitHub App" },
          { id: "skip", label: "Skip for now" },
        ],
      },
      {
        id: "model",
        title: "Model connection",
        choices: [
          { id: "byom", label: "Bring your own model (OpenAI-compatible base URL)" },
          { id: "siwc", label: "Sign in with ChatGPT" },
          { id: "api-key", label: "Provider API key via an AI Gateway BYOK alias" },
          { id: "skip", label: "Skip for now" },
        ],
      },
      {
        id: "sandbox",
        title: "Sandbox provider",
        choices: [
          { id: "cloudflare", label: "Cloudflare containers" },
          { id: "docker-local", label: "Local Docker" },
          { id: "computesdk", label: "ComputeSDK" },
          { id: "e2b", label: "E2B" },
        ],
      },
      {
        id: "testRepo",
        title: "Test repository",
        choices: [
          { id: "set", label: "Use a repository URL" },
          { id: "skip", label: "Skip for now" },
        ],
      },
    ],
  };
}

export interface SetupFixResult {
  ok: boolean;
  applied: boolean;
  userMessage: string;
  command?: string;
  providerId?: string;
}

export async function applySetupFix(env: Env, actionId: string): Promise<{ status: number; body: SetupFixResult }> {
  const providerId = APPLY_PROVIDERS[actionId];
  if (providerId) {
    if (!env.AGENT_AUDIT) {
      return {
        status: 200,
        body: {
          ok: true,
          applied: false,
          providerId,
          userMessage: `No audit database in this process. Set SHIBA_SANDBOX_PROVIDER=${providerId} in apps/backend/.dev.vars.`,
          command: `pnpm shiba setup fix ${actionId}`,
        },
      };
    }
    try {
      await setOrgSandboxProvider(env, "self-hosted", providerId);
      return {
        status: 200,
        body: {
          ok: true,
          applied: true,
          providerId,
          userMessage: `Sandbox provider set to ${providerId} for this org.`,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "sandbox provider update failed";
      return {
        status: 200,
        body: {
          ok: true,
          applied: false,
          providerId,
          userMessage: `Could not store the provider (${message.slice(0, 180)}). Set SHIBA_SANDBOX_PROVIDER=${providerId} in .dev.vars.`,
          command: `pnpm shiba setup fix ${actionId}`,
        },
      };
    }
  }
  const guide = GUIDES[actionId];
  if (!guide) {
    return {
      status: 400,
      body: { ok: false, applied: false, userMessage: `Unknown setup fix ${actionId}.` },
    };
  }
  return { status: 200, body: { ok: true, applied: false, userMessage: guide.userMessage, command: guide.command } };
}
