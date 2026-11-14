/**
 * AuthScreen — the built-in dashboard login (better-auth lane). Rendered
 * when /api/whoami 401s with `code: "better-auth"`, i.e. the deployment has
 * no Cloudflare Access app but does have BETTER_AUTH_SECRET.
 *
 * Sign-in, first-owner bootstrap and explicitly enabled invitation enrollment
 * share the form. Invited users must independently verify their email before
 * any dashboard identity resolves; their invitation is accepted separately.
 */
import { useEffect, useState, type FormEvent, type JSX } from "react";
import { authClient } from "../auth-client";
import { signInReturnPath } from "../auth-next";
import { AUTH_CLIENT_TIMEOUT_MS, AuthTimeoutError, withAuthTimeout } from "../auth-timeout";
import { ShibaMark } from "./ShibaMark";

const BOOTSTRAP_HEADER = "x-shiba-bootstrap-token";
const INVITATION_HEADER = "x-shiba-workspace-invitation";
function invitationFromHash(): string {
  if (typeof window === "undefined") return "";
  const token = new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? token : "";
}

type AuthMode = "signin" | "signup" | "invite" | "forgot" | "reset";

function initialAuthMode(suppliedInvitation?: string): AuthMode {
  if (typeof window === "undefined") return "signin";
  if (/^\/auth\/forgot\/?$/.test(window.location.pathname)) return "forgot";
  if (/^\/auth\/reset\/?$/.test(window.location.pathname)) return "reset";
  if (suppliedInvitation && /^[a-f0-9]{64}$/.test(suppliedInvitation)) return "invite";
  if (invitationFromHash()) return "invite";
  return "signin";
}

interface BootstrapPolicy {
  requiresToken: boolean;
  requiresOwnerEmail: boolean;
  locked: boolean;
}

type SocialProvider = "google" | "slack";
type SocialProviderStatus = { providers?: Partial<Record<SocialProvider, boolean>> };

export { SessionPending } from "./SessionPending";

export function SessionProblem({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="h-dvh bg-[var(--bg)] text-[var(--fg)] font-sans flex items-center justify-center p-6">
      <div className="bg-[var(--card)] border border-[var(--border-1)] max-w-sm w-full p-6 flex flex-col items-center text-center gap-3">
        <h1 className="text-xl">Cannot reach the dashboard</h1>
        <p role="alert" className="text-sm text-[var(--muted-foreground-2)] leading-relaxed">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="w-full min-h-11 bg-[var(--primary)] text-[var(--primary-text)] text-sm font-semibold"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export function AuthScreen({ onSignedIn, invitationToken: suppliedInvitation }: { onSignedIn: () => void; invitationToken?: string }): JSX.Element {
  const initialInvitation = suppliedInvitation && /^[a-f0-9]{64}$/.test(suppliedInvitation) ? suppliedInvitation : invitationFromHash();
  const [mode, setMode] = useState<AuthMode>(() => initialAuthMode(suppliedInvitation));
  const [resetToken, setResetToken] = useState(() =>
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [resetSent, setResetSent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [policy, setPolicy] = useState<BootstrapPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [invitationToken, setInvitationToken] = useState(initialInvitation);
  const [invitationPolicy, setInvitationPolicy] = useState<{ enabled: boolean; reason?: string } | null>(null);
  const [verificationPending, setVerificationPending] = useState(false);
  const [socialProviders, setSocialProviders] = useState<SocialProvider[]>([]);
  const [socialPending, setSocialPending] = useState<SocialProvider | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (invitationFromHash()) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    void fetch("/api/auth/bootstrap", { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as BootstrapPolicy) : null))
      .then((body) => {
        if (!cancelled && body && typeof body.locked === "boolean") setPolicy(body);
      })
      .catch(() => {});
    void fetch("/api/auth/invitation-policy", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { enabled: boolean; reason?: string } : null)
      .then((body) => { if (!cancelled && body && typeof body.enabled === "boolean") setInvitationPolicy(body); })
      .catch(() => {});
    void fetch("/api/auth/social-providers", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as SocialProviderStatus : null)
      .then((body) => {
        if (!cancelled && body?.providers) {
          setSocialProviders((["google", "slack"] as const).filter((provider) => body.providers?.[provider] === true));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function signInSocial(provider: SocialProvider): Promise<void> {
    setError(null);
    setSocialPending(provider);
    const next = signInReturnPath(window.location.search);
    try {
      const result = await withAuthTimeout(authClient.signIn.social({
        provider,
        callbackURL: next ?? "/app/",
        errorCallbackURL: "/app/?auth_error=1",
        requestSignUp: false,
      }), AUTH_CLIENT_TIMEOUT_MS);
      if (result.error) {
        setError(result.error.message?.trim() || "Provider sign-in failed. If this provider is not linked yet, sign in with email first, then link it in Settings → Account.");
      }
    } catch (caught) {
      setError(caught instanceof AuthTimeoutError ? caught.message : "Could not start provider sign-in. Try again.");
    } finally {
      setSocialPending(null);
    }
  }

  async function submitForgot(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const origin = window.location.origin;
      const response = await withAuthTimeout(fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), redirectTo: `${origin}/auth/reset` }),
      }), AUTH_CLIENT_TIMEOUT_MS);
      if (!response.ok) {
        setError("Could not send a reset email.");
        return;
      }
      setResetSent(true);
    } catch (caught) {
      setError(caught instanceof AuthTimeoutError ? caught.message : "Could not reach the auth service.");
    } finally {
      setPending(false);
    }
  }

  async function submitReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    const token = resetToken.trim();
    if (!token) {
      setError("This reset link is missing a token. Request a new reset email.");
      setPending(false);
      return;
    }
    try {
      const response = await withAuthTimeout(fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password, token }),
      }), AUTH_CLIENT_TIMEOUT_MS);
      if (!response.ok) {
        setError("Password could not be reset.");
        return;
      }
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof AuthTimeoutError ? caught.message : "Could not reach the auth service.");
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
  if (mode === "forgot") return submitForgot(event);
  if (mode === "reset") return submitReset(event);
    setError(null);
    setPending(true);
    const headers: Record<string, string> = {};
    if (mode === "signup" && setupToken.trim() !== "") {
      headers[BOOTSTRAP_HEADER] = setupToken.trim();
    }
    if (mode === "invite") {
      if (!invitationPolicy?.enabled || !/^[a-f0-9]{64}$/.test(invitationToken.trim())) {
        setError(invitationPolicy?.reason ?? "A valid invitation and configured email verification are required.");
        setPending(false);
        return;
      }
      headers[INVITATION_HEADER] = invitationToken.trim();
    }
    try {
      const result = await withAuthTimeout(
        mode !== "signin"
          ? authClient.signUp.email(
              {
                name: name.trim() || email.trim(),
                email: email.trim(),
                password,
                ...(mode === "invite" ? { callbackURL: "/app/?email_verified=1" } : {}),
              },
              { timeout: AUTH_CLIENT_TIMEOUT_MS, headers },
            )
          : authClient.signIn.email(
              {
                email: email.trim(),
                password,
              },
              { timeout: AUTH_CLIENT_TIMEOUT_MS },
            ),
      );
      if (result.error) {
        setError(
          result.error.message ??
            (mode === "signup"
              ? "Sign-up failed. An account may already exist."
              : "Sign-in failed. Check the email and password."),
        );
        return;
      }
      if (mode === "invite") {
        setVerificationPending(true);
        return;
      }
      if (mode === "signin") {
        const statusResponse = await withAuthTimeout(fetch("/api/auth/enrollment-status", { cache: "no-store" }));
        if (!statusResponse.ok) { setError("Your session could not be verified. Please sign in again."); return; }
        const status = await statusResponse.json() as { restricted?: boolean; emailVerified?: boolean };
        if (status.restricted && !status.emailVerified) { setVerificationPending(true); return; }
      }
      // Back to the OAuth consent screen that sent us here, if any.
      const next = signInReturnPath(window.location.search);
      if (next !== null) {
        window.location.assign(next);
        return;
      }
      onSignedIn();
    } catch (caught) {
      setError(
        caught instanceof AuthTimeoutError
          ? caught.message
          : "Could not reach the auth service. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="h-dvh bg-[var(--bg)] text-[var(--fg)] font-sans flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-sm w-full p-6 shadow-[var(--sh-sheet)] flex flex-col items-center text-center gap-3">
        <ShibaMark />
        <h1 className="text-xl">
          {mode === "invite" ? "Join your team"
            : mode === "signup" ? "Create the dashboard account"
            : mode === "forgot" ? "Forgot your password?"
            : mode === "reset" ? "Choose a new password"
            : "Sign in to continue"}
        </h1>
        <p className="text-sm text-[var(--muted-foreground-2)] leading-relaxed">
          {mode === "invite"
            ? "Use your invitation and verify its exact email address. Team membership does not grant deployment administration."
            : mode === "signup"
            ? policy?.locked
              ? "Owner sign-up is locked. The operator must configure a setup token before the first account can be created."
              : "The first account becomes the dashboard owner. Additional accounts require a workspace invitation and verified email setup."
            : mode === "forgot"
            ? "Enter your dashboard email. If it exists, you will receive a reset link."
            : mode === "reset"
            ? "Set a new password. Other dashboard sessions will be signed out."
            : "Sign in with your dashboard email and password."}
        </p>
        <form onSubmit={submit} className="w-full flex flex-col gap-2.5 mt-1 text-left">
          {mode !== "signin" && mode !== "forgot" && mode !== "reset" ? (
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
              Name
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]"
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]"
            />
          </label>
          {mode === "reset" ? (
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
              Reset token
              <input type="text" required value={resetToken} onChange={(event) => setResetToken(event.target.value)}
                className="w-full min-h-11 border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]" />
            </label>
          ) : null}
          {mode === "invite" ? (
            <>
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
                Invitation token
                <input type="password" required autoComplete="off" value={invitationToken}
                  onChange={(event) => setInvitationToken(event.target.value)}
                  className="w-full min-h-11 border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]" />
              </label>
              {!invitationPolicy?.enabled ? <p role="status" className="text-sm text-[var(--muted-foreground-2)]">
                {invitationPolicy?.reason ?? "Checking invitation enrollment availability…"}
              </p> : null}
            </>
          ) : null}
          {mode === "signup" && (policy === null || policy.requiresToken || policy.locked) ? (
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
              Setup token
              <input
                type="password"
                autoComplete="off"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                className="w-full min-h-11 border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]"
              />
            </label>
          ) : null}
          {mode !== "forgot" ? (
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
              Password
              <input
                type="password"
                required
                minLength={8}
                autoComplete={mode !== "signin" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]"
              />
            </label>
          ) : null}
          {resetSent ? <p role="status" className="text-sm text-[var(--muted-foreground-2)]">If the address exists, a reset link is on its way.</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-[var(--destructive)] ">
              {error}
            </p>
          ) : null}
          {verificationPending ? <p role="status" className="text-sm text-[var(--muted-foreground-2)]">
            Check your email and open the verification link. Keep this invitation tab open and return here to sign in after verifying. If you close it, sign in and reopen the original invitation link. You will still review and accept the workspace invitation yourself.
          </p> : null}
          {verificationPending ? <button type="button" disabled={pending} className="min-h-11 border border-[var(--border-1)] text-sm text-[var(--primary)] disabled:opacity-60"
            onClick={() => {
              setPending(true); setError(null);
              void withAuthTimeout(fetch("/api/auth/send-verification-email", { method: "POST",
                headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), callbackURL: "/app/?email_verified=1" }) }))
                .then((response) => { if (!response.ok) setError("Verification could not be sent. Ask your workspace owner to check the invitation and email setup."); })
                .catch(() => setError("The verification service did not answer. Try again."))
                .finally(() => setPending(false));
            }}>Resend verification email</button> : null}
          <button
            type="submit"
            disabled={pending || (mode === "signup" && policy?.locked === true) || (mode === "invite" && !invitationPolicy?.enabled) || (mode === "forgot" && resetSent)}
            className="w-full min-h-11 rounded-[var(--radius-button)] bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] disabled:opacity-60 text-[var(--primary-text)] text-sm font-semibold transition-colors shadow-[var(--sh-card)] active:scale-[0.98]"
          >
            {pending
              ? "Working…"
              : mode === "invite" ? "Create team account"
              : mode === "signup" ? "Create account"
              : mode === "forgot" ? "Send reset link"
              : mode === "reset" ? "Update password"
              : "Sign in"}
          </button>
        </form>
        {mode === "signin" ? (
          <div className="flex flex-col gap-2 w-full">
            <a href="/auth/forgot" className="text-xs text-[var(--primary)] hover:underline">Forgot password?</a>
          </div>
        ) : null}
        {mode === "signin" && socialProviders.length > 0 ? (
          <div className="w-full border-t border-[var(--border-1)] pt-3">
            <p className="mb-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Or sign in with a linked account</p>
            <div className="grid grid-cols-2 gap-2">
              {socialProviders.map((provider) => (
                <button key={provider} type="button" disabled={pending || socialPending !== null}
                  onClick={() => void signInSocial(provider)}
                  className="min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 text-sm font-medium text-[var(--fg)] hover:bg-[var(--secondary)] disabled:opacity-60">
                  {socialPending === provider ? "Opening…" : provider === "google" ? "Google" : "Slack"}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {mode !== "forgot" && mode !== "reset" ? (
          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setVerificationPending(false);
            }}
            className="text-xs text-[var(--primary)] hover:underline"
          >
            {mode !== "signin"
              ? "Have an account? Sign in"
              : "First sign-in? Create the account"}
          </button>
        ) : (
          <a href="/app/" className="text-xs text-[var(--primary)] hover:underline">Back to sign in</a>
        )}
        {mode !== "invite" ? <button type="button" className="min-h-11 text-xs text-[var(--primary)] hover:underline"
          onClick={() => { setMode("invite"); setError(null); setVerificationPending(false); }}>Have a team invitation?</button> : null}
      </div>
    </div>
  );
}
