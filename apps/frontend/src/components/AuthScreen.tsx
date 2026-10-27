/**
 * AuthScreen — the built-in dashboard login (better-auth lane). Rendered
 * when /api/whoami 401s with `code: "better-auth"`, i.e. the deployment has
 * no Cloudflare Access app but does have BETTER_AUTH_SECRET.
 *
 * Two modes share one form: sign in, and create the first account.
 * Sign-up closes server-side once a user exists. A public host also
 * refuses that first account until a setup token or an allowlisted
 * owner email is configured.
 */
import { useEffect, useState, type FormEvent, type JSX } from "react";
import { authClient } from "../auth-client";
import { signInReturnPath } from "../auth-next";
import { AUTH_CLIENT_TIMEOUT_MS, AuthTimeoutError, withAuthTimeout } from "../auth-timeout";
import { identifyMinilyticsUser, trackMinilyticsGoal } from "../minilytics";
import { ShibaMark } from "./ShibaMark";

const BOOTSTRAP_HEADER = "x-shiba-bootstrap-token";

interface BootstrapPolicy {
  requiresToken: boolean;
  requiresOwnerEmail: boolean;
  locked: boolean;
}

export function SessionPending(): JSX.Element {
  return (
    <div className="h-dvh bg-[var(--bg)] text-[var(--fg)] font-sans flex items-center justify-center">
      <p role="status" className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
        Checking your session…
      </p>
    </div>
  );
}

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
          className="w-full min-h-11 bg-[var(--primary)] text-white text-sm font-semibold"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [policy, setPolicy] = useState<BootstrapPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/bootstrap", { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as BootstrapPolicy) : null))
      .then((body) => {
        if (!cancelled && body && typeof body.locked === "boolean") setPolicy(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    const headers: Record<string, string> = {};
    if (mode === "signup" && setupToken.trim() !== "") {
      headers[BOOTSTRAP_HEADER] = setupToken.trim();
    }
    try {
      const result = await withAuthTimeout(
        mode === "signup"
          ? authClient.signUp.email(
              {
                name: name.trim() || email.trim(),
                email: email.trim(),
                password,
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
      if (mode === "signup") {
        trackMinilyticsGoal("signup_completed");
      }
      await identifyMinilyticsUser(email.trim());
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
      <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-sm w-full p-6 shadow-[var(--sh-overlay)] flex flex-col items-center text-center gap-3">
        <ShibaMark />
        <h1 className="text-xl">
          {mode === "signup" ? "Create the dashboard account" : "Sign in to continue"}
        </h1>
        <p className="text-sm text-[var(--muted-foreground-2)] leading-relaxed">
          {mode === "signup"
            ? policy?.locked
              ? "Sign-up is locked on this public deployment. The operator must set a setup token or an allowlisted owner email before the first account can be created."
              : "The first account becomes the dashboard owner. Sign-up closes after it."
            : "Sign in with your dashboard email and password."}
        </p>
        <form onSubmit={submit} className="w-full flex flex-col gap-2.5 mt-1 text-left">
          {mode === "signup" ? (
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
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
            Password
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-[var(--destructive)] ">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending || (mode === "signup" && policy?.locked === true)}
            data-ml-goal={mode === "signup" ? "signup_click" : undefined}
            className="w-full min-h-11 rounded-[var(--radius-button)] bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] disabled:opacity-60 text-white text-sm font-semibold transition-colors shadow-[var(--sh-card)] active:scale-[0.98]"
          >
            {pending
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setError(null);
          }}
          className="text-xs text-[var(--primary)] hover:underline"
        >
          {mode === "signup"
            ? "Have an account? Sign in"
            : "First sign-in? Create the account"}
        </button>
      </div>
    </div>
  );
}
