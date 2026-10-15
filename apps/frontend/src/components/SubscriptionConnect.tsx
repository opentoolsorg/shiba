/**
 * SubscriptionConnect — the shared connect/disconnect control for the
 * subscription-auth lanes (T48–T50): begin/verify/clear on
 * /api/auth/<provider>, plus the antigravity pasted-redirect callback.
 * Mounted by the Agents & MCP connector cards and by Settings → Providers.
 * The SHIBA_* flag gates the route too, so a 404 means the deployment has
 * it off — rendered as an unavailable hint, never a broken card.
 */

import type { AuthSnapshot } from "@shiba/shared";
import { type JSX, useEffect, useRef, useState } from "react";

export interface AgentCliCredential {
  kind: "ai-gateway-byok" | "worker-secret" | "oauth-signin";
  label: string;
  configured: boolean | null;
  setupHint: string | null;
}

export type SubscriptionId =
  | "claude-subscription"
  | "codex-subscription"
  | "antigravity-subscription"
  | "cursor-subscription"
  | "devin-subscription";

export const SUBSCRIPTION_AUTH: Record<
  SubscriptionId,
  {
    apiBase: string;
    flag: string;
    oauthRedirect: boolean;
    label: string;
    binary: string;
    blurb: string;
    docsUrl: string;
    /** Rendered when the flag is off and the catalog has no row for the card. */
    credential: AgentCliCredential;
  }
> = {
  "claude-subscription": {
    apiBase: "/api/auth/claude-subscription",
    flag: "SHIBA_CLAUDE_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Claude",
    binary: "claude",
    blurb: "Claude Pro/Max subscription — setup token held as a Worker secret.",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    credential: {
      kind: "worker-secret",
      label: "CLAUDE_SUBSCRIPTION_TOKEN",
      configured: null,
      setupHint: "claude setup-token, then npx wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN",
    },
  },
  "codex-subscription": {
    apiBase: "/api/auth/codex-subscription",
    flag: "SHIBA_CODEX_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Codex",
    binary: "codex",
    blurb: "ChatGPT subscription — Codex auth.json held as a Worker secret.",
    docsUrl: "https://github.com/openai/codex",
    credential: {
      kind: "worker-secret",
      label: "CODEX_SUBSCRIPTION_AUTH_JSON",
      configured: null,
      setupHint:
        "codex login, then npx wrangler secret put CODEX_SUBSCRIPTION_AUTH_JSON < ~/.codex/auth.json",
    },
  },
  "antigravity-subscription": {
    apiBase: "/api/auth/antigravity-subscription",
    flag: "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
    oauthRedirect: true,
    label: "Antigravity",
    binary: "agy",
    blurb: "Google account sign-in — OAuth runs inside the auth sandbox.",
    docsUrl: "https://antigravity.google",
    credential: {
      kind: "oauth-signin",
      label: "Google sign-in (in-container OAuth)",
      configured: null,
      setupHint: null,
    },
  },
  "cursor-subscription": {
    apiBase: "/api/auth/cursor-subscription",
    flag: "SHIBA_CURSOR_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Cursor",
    binary: "cursor-agent",
    blurb: "Cursor subscription — Agent API key held as a Worker secret.",
    docsUrl: "https://cursor.com/docs",
    credential: {
      kind: "worker-secret",
      label: "CURSOR_SUBSCRIPTION_TOKEN",
      configured: null,
      setupHint: "npx wrangler secret put CURSOR_SUBSCRIPTION_TOKEN",
    },
  },
  "devin-subscription": {
    apiBase: "/api/auth/devin-subscription",
    flag: "SHIBA_DEVIN_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Devin",
    binary: "devin",
    blurb: "Devin subscription — API key/session token held as a Worker secret.",
    docsUrl: "https://docs.devin.ai",
    credential: {
      kind: "worker-secret",
      label: "DEVIN_SUBSCRIPTION_TOKEN",
      configured: null,
      setupHint: "devin auth login, then npx wrangler secret put DEVIN_SUBSCRIPTION_TOKEN",
    },
  },
};

export type SubscriptionStatus =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unavailable" }
  | { kind: "snapshot"; snapshot: AuthSnapshot };

const CHIP_TONES = {
  ok: "border-[color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  danger: "border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] text-[var(--destructive)]",
  pending: "border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[var(--warning-subtle)] text-[var(--warning-fg)]",
  navy: "border-[var(--primary)]/30 bg-[var(--primary-soft)] text-[var(--primary)]",
  neutral: "border-[var(--border-2)] bg-[var(--secondary)] text-[var(--muted-foreground-2)]",
} as const;

const CHIP_DOTS = {
  ok: "bg-[var(--success)]",
  danger: "bg-[var(--destructive)]",
  pending: "bg-[var(--warning)]",
  navy: "bg-[var(--primary)]",
  neutral: "bg-[var(--muted-foreground-3)]",
} as const;

export function chip(tone: keyof typeof CHIP_TONES, label: string): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border px-2 py-0.5 text-[11px] font-medium ${CHIP_TONES[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${CHIP_DOTS[tone]}`} />
      {label}
    </span>
  );
}

/** The card chip reflects the live auth-flow phase, not credential presence. */
export function subscriptionChip(status: SubscriptionStatus | undefined): JSX.Element {
  if (status?.kind === "unavailable") return chip("neutral", "Unavailable");
  if (status?.kind === "error") return chip("pending", "Could not check");
  const phase = status?.kind === "snapshot" ? status.snapshot.phase : undefined;
  switch (phase) {
    case "succeeded":
      return chip("ok", "Connected");
    case "failed":
      return chip("danger", "Auth failed");
    case "waiting":
      return chip("pending", "Sign-in pending");
    case "starting":
    case "verifying":
      return chip("navy", "Connecting");
    case "idle":
    case "cleared":
      return chip("neutral", "Not connected");
    default:
      return chip("neutral", "Checking…");
  }
}

const CONNECT_PRIMARY =
  "bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] text-white font-semibold py-1 px-3 rounded-[var(--radius-button)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-mono shadow-[var(--sh-card)] active:translate-y-px";
const CONNECT_SECONDARY =
  "text-[11px] font-mono font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] border border-[var(--border-1)] hover:border-[var(--border-2)] bg-[var(--card)] px-2.5 py-1 rounded-[var(--radius-button)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Connect/Disconnect for one subscription lane. Status comes from the flow
 * snapshot (`GET /api/auth/<provider>`), not optimistic state. Secret-token
 * providers run begin → verify in one shot; antigravity runs the pasted-
 * redirect loop: begin → open authorizationUrl → POST /api/antigravity/
 * callback → verify.
 */
export function SubscriptionConnect({
  spec,
  credential,
  onStatus,
}: {
  spec: (typeof SUBSCRIPTION_AUTH)[SubscriptionId];
  credential: AgentCliCredential;
  onStatus: (status: SubscriptionStatus) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteUrl, setPasteUrl] = useState("");
  const [callbackSent, setCallbackSent] = useState(false);
  const account = "default";

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const applySnapshot = (next: AuthSnapshot | undefined) => {
    if (next === undefined) return;
    setSnapshot(next);
    onStatusRef.current({ kind: "snapshot", snapshot: next });
  };

  const markUnavailable = () => {
    setUnavailable(true);
    onStatusRef.current({ kind: "unavailable" });
  };

  /** POST a flow verb; returns the fresh snapshot, undefined when the route is dark. */
  const callFlow = async (
    verb: "begin" | "verify" | "clear",
  ): Promise<AuthSnapshot | undefined> => {
    const response = await fetch(`${spec.apiBase}/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account }),
    });
    if (response.status === 404) {
      markUnavailable();
      return undefined;
    }
    const body = (await response.json().catch(() => ({}))) as {
      snapshot?: AuthSnapshot;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `Auth request failed: ${response.status}`);
    }
    if (body.snapshot === undefined) throw new Error("The connection status could not be read. Try again.");
    applySnapshot(body.snapshot);
    return body.snapshot;
  };

  const refresh = async (): Promise<void> => {
    const response = await fetch(`${spec.apiBase}?account=${account}`);
    if (response.status === 404) {
      markUnavailable();
      return;
    }
    if (!response.ok) throw new Error("The connection status could not be checked. Try again.");
    const body = (await response.json().catch(() => ({}))) as { snapshot?: AuthSnapshot };
    if (body.snapshot === undefined) throw new Error("The connection status could not be read. Try again.");
    applySnapshot(body.snapshot);
  };

  useEffect(() => {
    let cancelled = false;
    onStatusRef.current({ kind: "loading" });
    (async () => {
      try {
        const response = await fetch(`${spec.apiBase}?account=default`);
        if (response.status === 404) {
          if (!cancelled) {
            setUnavailable(true);
            onStatusRef.current({ kind: "unavailable" });
          }
          return;
        }
        if (!response.ok) throw new Error("Connection status is unavailable.");
        const body = (await response.json().catch(() => ({}))) as { snapshot?: AuthSnapshot };
        if (body.snapshot === undefined) throw new Error("Connection status was not reported.");
        if (!cancelled) {
          setSnapshot(body.snapshot);
          onStatusRef.current({ kind: "snapshot", snapshot: body.snapshot });
        }
      } catch {
        if (!cancelled) {
          setFlowError("We could not check this connection. Try connecting again, or contact your administrator if this continues.");
          onStatusRef.current({ kind: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec.apiBase]);

  /** Run a flow step; a thrown error lands in the card and a refresh restores truth. */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFlowError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setFlowError(err instanceof Error ? err.message : String(err));
      await refresh().catch(() => onStatusRef.current({ kind: "error" }));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    void run(async () => {
      const snap = await callFlow("begin");
      if (snap === undefined) return;
      if (spec.oauthRedirect) {
        setCallbackSent(false);
        // Popup blockers can refuse an async open — the waiting panel always
        // renders the same URL as a link.
        if (snap?.authorizationUrl !== undefined) {
          window.open(snap.authorizationUrl, "_blank", "noopener,noreferrer");
        }
      } else {
        await callFlow("verify");
      }
    });

  const submitPaste = () =>
    void run(async () => {
      const response = await fetch("/api/antigravity/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, url: pasteUrl.trim() }),
      });
      if (response.status === 404) {
        markUnavailable();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `Callback request failed: ${response.status}`);
      }
      setCallbackSent(true);
      setPasteUrl("");
      setNotice(body.message ?? "Sign-in response delivered.");
      await callFlow("verify");
    });

  const verifyAgain = () => void run(async () => void (await callFlow("verify")));

  const disconnect = () =>
    void run(async () => {
      await callFlow("clear");
      setCallbackSent(false);
      setPasteUrl("");
    });

  const phase = snapshot?.phase;
  const needsSecret = credential.kind === "worker-secret" && credential.configured === false;
  const owner =
    snapshot?.ownerSessionId !== null &&
    snapshot?.ownerSessionId !== undefined &&
    snapshot.ownerSessionId !== "default"
      ? snapshot.ownerSessionId
      : undefined;

  return (
    <div className="mt-3 space-y-2 border-t border-[var(--border-1)] pt-3">
      {unavailable ? (
        <div className="space-y-2">
          <p className="border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[var(--warning-subtle)] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--warning-fg)]">
            {spec.label} subscription sign-in is not enabled on this deployment. Ask your
            administrator to enable it, or choose another provider.
          </p>
          <button type="button" disabled className={CONNECT_PRIMARY}>
            Connect
          </button>
        </div>
      ) : phase === "waiting" ? (
        <div className="space-y-2">
          <p className="font-mono text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            {snapshot?.message ??
              "Open the sign-in URL, complete sign-in, then paste the failed redirect URL."}
            {owner !== undefined ? ` Owner: ${owner}.` : ""}
          </p>
          {snapshot?.authorizationUrl !== undefined ? (
            <div>
              <a
                href={snapshot.authorizationUrl}
                target="_blank"
                rel="noreferrer"
                className={`${CONNECT_PRIMARY} inline-flex`}
              >
                Open sign-in ↗
              </a>
            </div>
          ) : null}
          {callbackSent ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={verifyAgain}
                disabled={busy}
                className={CONNECT_PRIMARY}
              >
                {busy ? "Checking…" : "Check status"}
              </button>
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className={CONNECT_SECONDARY}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={pasteUrl}
                onChange={(event) => setPasteUrl(event.target.value)}
                placeholder="http://127.0.0.1:…/?code=…&state=…"
                aria-label="Pasted OAuth redirect URL"
                className="min-w-0 flex-1 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--fg)] transition-colors placeholder-[var(--muted-foreground-3)]/60 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]/40"
              />
              <button
                type="button"
                onClick={submitPaste}
                disabled={busy || pasteUrl.trim() === ""}
                className={CONNECT_PRIMARY}
              >
                {busy ? "Sending…" : "Submit"}
              </button>
            </div>
          )}
          {callbackSent ? null : (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="font-mono text-[10px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
            >
              Cancel sign-in
            </button>
          )}
        </div>
      ) : phase === "succeeded" ? (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-[var(--success)]">
            account: {account}
            {owner !== undefined ? ` · ${owner}` : ""}
            {snapshot?.expiresAt !== undefined
              ? ` · valid until ${new Date(snapshot.expiresAt).toLocaleDateString()}`
              : ""}
          </span>
          <button type="button" onClick={disconnect} disabled={busy} className={CONNECT_SECONDARY}>
            {busy ? "…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-[var(--muted-foreground-2)]">
            {phase === "starting" || phase === "verifying"
              ? "Connecting…"
              : phase === "failed"
                ? "Connection failed"
                : "Subscription account"}
          </span>
          <div className="flex items-center gap-2">
            {spec.oauthRedirect && phase === "failed" ? (
              <button
                type="button"
                onClick={verifyAgain}
                disabled={busy}
                className={CONNECT_SECONDARY}
              >
                Check again
              </button>
            ) : null}
            <button
              type="button"
              onClick={connect}
              disabled={busy || needsSecret}
              className={CONNECT_PRIMARY}
            >
              {busy ? "Connecting…" : phase === "failed" ? "Retry connect" : "Connect"}
            </button>
          </div>
        </div>
      )}
      {!unavailable && needsSecret && phase !== "succeeded" ? (
        <p className="border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[var(--warning-subtle)] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--warning-fg)]">
          This provider needs a deployment credential before you can connect. Ask your
          administrator to configure it, or choose another provider.
        </p>
      ) : null}
      {flowError !== null ? (
        <div className="border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--destructive)]">
          {flowError}
        </div>
      ) : null}
      {notice !== null && flowError === null ? (
        <div className="border border-[var(--primary)]/25 bg-[var(--primary-soft)] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--primary)]">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
