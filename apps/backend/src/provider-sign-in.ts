/**
 * Real provider sign-in for the dashboard cards.
 *
 * Codex uses the per-user Sign in with ChatGPT PKCE flow (paste the loopback
 * callback — Cloudflare has no listener on 127.0.0.1). Tokens stay encrypted
 * in ChatGptAuth; runs attach them at egress.
 *
 * Claude prefers the operator's own `claude` CLI on a paired local daemon.
 * `claude setup-token` is an explicit opt-in that stores a Worker secret and
 * may conflict with Anthropic's terms.
 */
import type { SubscriptionForwarder } from "@shiba/auth";
import { claudeSubscriptionAuth } from "@shiba/auth";
import { LOCAL_RUNTIME_FLAG, type AcpSignInKind, type ConnectedComputer } from "@shiba/shared";
import { mintDaemonPairing } from "./computers-routes.js";
import { type EgressEnv, forwardClaudeSubscription } from "./egress.js";
import type { Env } from "./env.js";
import { chatGptAuthStub } from "./chatgpt-auth-do.js";
import { localDispatchStub } from "./local-dispatch.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";

const SIGN_IN_TTL_MS = 15 * 60 * 1000;
const LEGAL = "https://code.claude.com/docs/en/legal-and-compliance";
const QUIET_AUTH_PHASES = new Set(["idle", "cleared", "failed"]);

export interface SignInContext {
  mode: "oauth" | "setup-token";
  origin: string;
  now: number;
}

export interface SignInSession {
  ok: boolean;
  pending: boolean;
  message: string;
  verificationUri?: string;
  signInKind?: AcpSignInKind;
  operatorSteps?: string[];
  expiresAt?: number;
}

export interface SignInVerdict {
  ok: boolean;
  message: string;
  operatorSteps?: string[];
}

export interface SignInLanes {
  forwardClaude?: SubscriptionForwarder;
}

export const CODEX_OPERATOR_STEPS = [
  "Set MODEL_CREDENTIAL_KEY to 64 hex characters: openssl rand -hex 32 | npx wrangler secret put MODEL_CREDENTIAL_KEY --config apps/backend/wrangler.jsonc",
  "ChatGptAuth and AGENT_AUDIT are already bound on a standard deploy. No AI_GATEWAY_TOKEN, SHIBA_CODEX_SUBSCRIPTION, or CODEX_SUBSCRIPTION_AUTH_JSON is required for this lane.",
  "Connect with sign-in, open the auth.openai.com link, sign in with the ChatGPT account that has Codex, and copy the final http://127.0.0.1:<port>/auth/callback address from the browser (the page itself will fail to load).",
  "Paste that callback on this card and choose Finish sign-in. The code is exchanged on the Worker and stored encrypted for your user.",
  "Run a task with harness Codex (ChatGPT plan) / codex-subscription. Approve it. The sandbox receives a placeholder; egress attaches the access token.",
];

export const CLAUDE_DAEMON_STEPS = [
  "Set SHIBA_LOCAL_RUNTIME=1 (wrangler var) so the dashboard can admit runtime local. LocalDispatch is already in wrangler.jsonc.",
  "Set a pairing secret: npx wrangler secret put PAIRING_SECRET --config apps/backend/wrangler.jsonc (LOCAL_ADAPTER_TOKEN also works).",
  "On your computer, install Claude Code and run: claude auth login",
  "Connect with sign-in again. Run the one-time node scripts/shiba-local-daemon.mjs --connect <origin> --pair <token> command shown on this card.",
  "After the daemon heartbeats, choose Finish sign-in. Submit the task with runtime Local and harness Claude Code. Shiba never reads the Claude credential.",
  `Opt-in fallback only — may violate Anthropic's terms (${LEGAL}): set SHIBA_CLAUDE_SUBSCRIPTION=1, run claude setup-token, then npx wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN --config apps/backend/wrangler.jsonc, and use Use setup-token on this card.`,
];

const CLAUDE_SETUP_STEPS = [
  `This path stores a Claude setup-token at the Worker egress boundary and may violate Anthropic's terms (${LEGAL}). Prefer the local daemon.`,
  "Set SHIBA_CLAUDE_SUBSCRIPTION=1 on the Worker.",
  "On your computer run: claude setup-token",
  "npx wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN --config apps/backend/wrangler.jsonc",
  "Choose Use setup-token on this card again. Runs use harness claude-subscription. The container gets a placeholder; egress attaches the token. AI_GATEWAY_TOKEN is not used.",
];

function claudeForward(lanes: SignInLanes): SubscriptionForwarder {
  return (
    lanes.forwardClaude ??
    ((request, env, ctx) => forwardClaudeSubscription(request, env as EgressEnv, ctx))
  );
}

function safeMessage(value: unknown, fallback: string): string {
  const message =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : fallback;
  if (message.length > 300 || /bearer\s+\S{8,}/i.test(message) || message.includes("sk-")) {
    return fallback;
  }
  return message;
}

function isOpenAiAuthorize(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com";
  } catch {
    return false;
  }
}

export function isLoopbackCallback(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

async function listComputers(env: Env): Promise<ConnectedComputer[]> {
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) return [];
  const response = await localDispatchStub(env).fetch(new Request("https://local-dispatch/computers"));
  if (!response.ok) return [];
  const body = (await response.json().catch(() => null)) as { computers?: unknown } | null;
  if (!Array.isArray(body?.computers)) return [];
  return body.computers.filter((row): row is ConnectedComputer => {
    if (typeof row !== "object" || row === null) return false;
    const computer = row as ConnectedComputer;
    return typeof computer.hostname === "string" && Array.isArray(computer.harnesses);
  });
}

function readyClaudeDaemon(computers: readonly ConnectedComputer[]): ConnectedComputer | undefined {
  return computers.find(
    (computer) => computer.status !== "offline" && computer.harnesses.includes("claude"),
  );
}

async function beginCodex(env: Env, org: string, ctx: SignInContext): Promise<SignInSession> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      pending: false,
      signInKind: "chatgpt-pkce",
      message:
        "ChatGPT sign-in is not available until per-user token storage is configured. This card will not invent a confirmation code.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/begin", {
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as { authorizeUrl?: unknown; error?: unknown } | null;
  if (!response.ok) {
    return {
      ok: false,
      pending: false,
      signInKind: "chatgpt-pkce",
      message: safeMessage(body, "ChatGPT sign-in could not start."),
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  const authorizeUrl = typeof body?.authorizeUrl === "string" ? body.authorizeUrl : "";
  if (!isOpenAiAuthorize(authorizeUrl)) {
    return {
      ok: false,
      pending: false,
      signInKind: "chatgpt-pkce",
      message: "ChatGPT sign-in returned an unexpected address. Start again.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  return {
    ok: true,
    pending: true,
    signInKind: "chatgpt-pkce",
    verificationUri: authorizeUrl,
    expiresAt: ctx.now + SIGN_IN_TTL_MS,
    message:
      "Open the auth.openai.com link, sign in, then paste the http://127.0.0.1 callback URL from the address bar. The browser error page is expected. Finish sign-in exchanges it here.",
    operatorSteps: [
      "Open the sign-in link and approve ChatGPT plan access (chatgpt.tokens.use.direct).",
      "Copy the final http://127.0.0.1:<port>/auth/callback URL and paste it below.",
      "Choose Finish sign-in. The access token stays encrypted on the Worker.",
    ],
  };
}

async function completeCodex(env: Env, org: string, callbackUrl: string | null): Promise<SignInVerdict> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      message: "ChatGPT sign-in is not configured on this deployment.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  if (callbackUrl === null || !isLoopbackCallback(callbackUrl)) {
    return {
      ok: false,
      message: "Paste the http://127.0.0.1 callback URL from the browser address bar.",
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2, 4),
    };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    connected?: unknown;
    planUsageEnabled?: unknown;
  } | null;
  if (!response.ok) {
    return {
      ok: false,
      message: safeMessage(body, "ChatGPT sign-in could not be completed."),
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2),
    };
  }
  if (body?.planUsageEnabled === false) {
    return {
      ok: false,
      message:
        "Signed in, but ChatGPT plan usage was not granted. Start sign-in again and accept chatgpt.tokens.use.direct, or the run cannot use your subscription.",
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2, 4),
    };
  }
  if (body?.connected === false) {
    return { ok: false, message: "ChatGPT did not confirm the connection. Start sign-in again.", operatorSteps: CODEX_OPERATOR_STEPS.slice(2) };
  }
  return {
    ok: true,
    message:
      "ChatGPT plan connected. Runs use codex-subscription. The access token stays encrypted for this user and is attached at egress. AI_GATEWAY_TOKEN is not required.",
  };
}

async function inspectCodex(env: Env, org: string): Promise<SignInVerdict> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      message: "ChatGPT plan storage is not configured.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/status");
  if (!response.ok) {
    return { ok: false, message: "ChatGPT plan status could not be read.", operatorSteps: CODEX_OPERATOR_STEPS.slice(0, 2) };
  }
  const body = (await response.json().catch(() => null)) as {
    connected?: unknown;
    planUsageEnabled?: unknown;
  } | null;
  if (body?.connected === true && body.planUsageEnabled !== false) {
    return {
      ok: true,
      message:
        "ChatGPT plan is connected for this user. codex-subscription can run without AI_GATEWAY_TOKEN. Egress attaches the access token; the sandbox only sees a placeholder.",
    };
  }
  if (body?.connected === true && body.planUsageEnabled === false) {
    return {
      ok: false,
      message: "ChatGPT is connected but plan usage is disabled. Re-consent from Connect with sign-in.",
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2, 4),
    };
  }
  return {
    ok: false,
    message: "No ChatGPT plan is connected for this user.",
    operatorSteps: CODEX_OPERATOR_STEPS.slice(2),
  };
}

async function beginClaudeDaemon(env: Env, ctx: SignInContext): Promise<SignInSession> {
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-daemon",
      message:
        "Claude cannot sign in from this page. A Cloudflare container has no loopback, and storing a Claude.ai session here may violate Anthropic's terms. Pair your own claude CLI instead.",
      operatorSteps: CLAUDE_DAEMON_STEPS,
    };
  }
  const ready = readyClaudeDaemon(await listComputers(env));
  if (ready) {
    return {
      ok: true,
      pending: false,
      signInKind: "claude-daemon",
      message: `Paired daemon ${ready.hostname} has the claude CLI. Run tasks with runtime Local and harness Claude Code. Credentials stay on that machine (claude auth login). AI_GATEWAY_TOKEN is not used.`,
      operatorSteps: [
        "On that machine, run claude auth login if you have not already.",
        "In the task composer, set runtime to Local and harness to Claude Code.",
      ],
    };
  }
  const minted = await mintDaemonPairing(env, ctx.origin);
  if (!minted.ok) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-daemon",
      message: minted.message,
      operatorSteps: CLAUDE_DAEMON_STEPS,
    };
  }
  return {
    ok: true,
    pending: true,
    signInKind: "claude-daemon",
    expiresAt: minted.expiresAt,
    message:
      "No paired computer has reported the claude CLI yet. Run this command on your machine, then claude auth login, then Finish sign-in.",
    operatorSteps: [
      minted.command,
      "claude auth login",
      "Finish sign-in after the daemon heartbeat. Then run the task with runtime Local and harness Claude Code.",
    ],
  };
}

async function completeClaudeDaemon(env: Env): Promise<SignInVerdict> {
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return {
      ok: false,
      message: "The local runtime is not enabled, so Claude sign-in cannot finish.",
      operatorSteps: CLAUDE_DAEMON_STEPS,
    };
  }
  const ready = readyClaudeDaemon(await listComputers(env));
  if (!ready) {
    return {
      ok: false,
      message:
        "No paired machine has reported the claude CLI yet. Install Claude Code, run claude auth login, start the daemon, then Finish sign-in again.",
      operatorSteps: CLAUDE_DAEMON_STEPS.slice(2, 5),
    };
  }
  return {
    ok: true,
    message: `Paired daemon ${ready.hostname} has the claude CLI. Run tasks with runtime Local and harness Claude Code. Shiba does not copy the Claude credential. AI_GATEWAY_TOKEN is not required.`,
  };
}

async function beginClaudeSetupToken(env: Env, org: string, lanes: SignInLanes): Promise<SignInSession> {
  if (env.SHIBA_CLAUDE_SUBSCRIPTION !== "1") {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-setup-token",
      message:
        "Setup-token is off. Claude sign-in on this card pairs a local daemon. Turn the flag on only if you accept storing a setup-token at egress.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  const token = env.CLAUDE_SUBSCRIPTION_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-setup-token",
      message: "CLAUDE_SUBSCRIPTION_TOKEN is not set. This card does not accept a pasted token.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  const controller = claudeSubscriptionAuth(env, "claude-sub:default", claudeForward(lanes));
  const current = await controller.snapshot();
  if (current.phase === "succeeded") {
    return {
      ok: true,
      pending: false,
      signInKind: "claude-setup-token",
      message:
        current.message ??
        "Setup-token lane is already authenticated. Runs use claude-subscription without AI_GATEWAY_TOKEN. The container holds a placeholder.",
    };
  }
  if (!QUIET_AUTH_PHASES.has(current.phase)) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-setup-token",
      message: `Subscription sign-in is ${current.phase}. This page will not interrupt it.`,
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  try {
    await controller.begin(org);
    const snapshot = await controller.verify(org);
    return {
      ok: snapshot.phase === "succeeded",
      pending: false,
      signInKind: "claude-setup-token",
      message: snapshot.message ?? snapshot.phase,
      ...(!snapshot.phase || snapshot.phase !== "succeeded" ? { operatorSteps: CLAUDE_SETUP_STEPS } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-setup-token",
      message: error instanceof Error ? safeMessage({ error: error.message }, "Setup-token probe failed.") : "Setup-token probe failed.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
}

async function inspectClaude(env: Env, lanes: SignInLanes): Promise<SignInVerdict> {
  const ready = readyClaudeDaemon(await listComputers(env));
  if (ready) {
    return {
      ok: true,
      message: `Daemon ${ready.hostname} still reports the claude CLI. Local runs do not use AI_GATEWAY_TOKEN.`,
    };
  }
  if (env.SHIBA_CLAUDE_SUBSCRIPTION === "1" && env.CLAUDE_SUBSCRIPTION_TOKEN?.trim()) {
    const controller = claudeSubscriptionAuth(env, "claude-sub:default", claudeForward(lanes));
    const current = await controller.snapshot();
    if (current.phase === "succeeded") {
      return {
        ok: true,
        message:
          current.message ??
          "Setup-token lane is authenticated. claude-subscription does not use AI_GATEWAY_TOKEN.",
      };
    }
    return {
      ok: false,
      message: `No paired claude CLI, and the setup-token lane is ${current.phase}. Test does not restart sign-in.`,
      operatorSteps: CLAUDE_DAEMON_STEPS,
    };
  }
  return {
    ok: false,
    message: "No paired computer is reporting the claude CLI.",
    operatorSteps: CLAUDE_DAEMON_STEPS,
  };
}

export async function beginProviderSignIn(
  env: Env,
  provider: { id: string; label: string },
  org: string,
  ctx: SignInContext,
  lanes: SignInLanes = {},
): Promise<SignInSession> {
  if (provider.id === "codex") {
    if (ctx.mode === "setup-token") {
      return {
        ok: false,
        pending: false,
        message: "Codex has no setup-token lane. Use Connect with sign-in.",
        operatorSteps: CODEX_OPERATOR_STEPS,
      };
    }
    return beginCodex(env, org, ctx);
  }
  if (provider.id === "claude") {
    if (ctx.mode === "setup-token") return beginClaudeSetupToken(env, org, lanes);
    return beginClaudeDaemon(env, ctx);
  }
  return {
    ok: false,
    pending: false,
    message: `${provider.label} has no sign-in flow. Connect with the API credential instead.`,
    operatorSteps: gatewayOperatorSteps(provider.label),
  };
}

export async function completeProviderSignIn(
  env: Env,
  provider: { id: string; label: string },
  org: string,
  callbackUrl: string | null,
): Promise<SignInVerdict> {
  if (provider.id === "codex") return completeCodex(env, org, callbackUrl);
  if (provider.id === "claude") return completeClaudeDaemon(env);
  return { ok: false, message: `${provider.label} has no sign-in to finish.` };
}

export async function inspectProviderSignIn(
  env: Env,
  provider: { id: string; label: string },
  org: string,
  lanes: SignInLanes = {},
): Promise<SignInVerdict> {
  if (provider.id === "codex") return inspectCodex(env, org);
  if (provider.id === "claude") return inspectClaude(env, lanes);
  return { ok: false, message: `${provider.label} has no subscription lane.` };
}

export function gatewayOperatorSteps(label: string): string[] {
  return [
    `${label} has no subscription sign-in on this card. It runs only through Cloudflare AI Gateway BYOK.`,
    "npx wrangler secret put AI_GATEWAY_TOKEN --config apps/backend/wrangler.jsonc",
    "Store the provider API key in that AI Gateway (GATEWAY_ID, or default) as the BYOK credential for this provider.",
    "This page does not accept a pasted API key, and there is no subscription lane that bypasses the gateway.",
  ];
}
