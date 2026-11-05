import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { BootstrapVerificationError, confirmBootstrapVerification, getBootstrapVerificationStatus, requestBootstrapVerification, type BootstrapVerificationStatus } from "../bootstrap-verification-client";

const button = "min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 text-sm disabled:opacity-50";
const safeError = (error: unknown) => error instanceof BootstrapVerificationError ? error.message : "Verification could not be reached. Try again after checking your account.";

export function BootstrapVerificationPanel({ identityKey, onVerified }: { identityKey: string; onVerified?: () => void }): JSX.Element {
  return <VerificationPanel key={identityKey} onVerified={onVerified} />;
}
function VerificationPanel({ onVerified }: { onVerified?: () => void }): JSX.Element {
  const scope = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<BootstrapVerificationStatus | null>(null);
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (controller: AbortController) => {
    try {
      const next = await getBootstrapVerificationStatus(controller.signal);
      if (scope.current !== controller || controller.signal.aborted) return;
      setStatus(next); setError(null);
      if (next.emailVerified) onVerified?.();
    } catch (caught) { if (scope.current === controller && !controller.signal.aborted) { setStatus(null); setMessage(null); setError(safeError(caught)); } }
    finally { if (scope.current === controller && !controller.signal.aborted) setPending(false); }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: The keyed inner form owns one authenticated scope; refresh uses the latest render's callback.
  useEffect(() => {
    const controller = new AbortController(); scope.current = controller; setPending(true); void load(controller);
    return () => { controller.abort(); if (scope.current === controller) scope.current = null; };
  }, []);
  const refresh = () => { scope.current?.abort(); const controller = new AbortController(); scope.current = controller; setStatus(null); setMessage(null); setPending(true); void load(controller); };
  const send = async () => {
    if (!status || !status.available || status.emailVerified || pending) return;
    const controller = scope.current; if (!controller || controller.signal.aborted) return;
    setPending(true); setError(null); setMessage(null);
    try {
      const result = await requestBootstrapVerification(status.statusSnapshot, controller.signal);
      if (scope.current === controller && !controller.signal.aborted) {
        if (result === "verified") { setStatus({ ...status, emailVerified: true }); onVerified?.(); }
        else setMessage("Check your email. Open the link, then choose Confirm email. No new account or sign-in is created.");
      }
    } catch (caught) { if (scope.current === controller && !controller.signal.aborted) {
      if (caught instanceof BootstrapVerificationError && [401, 403, 404, 409].includes(caught.status)) setStatus(null);
      setError(safeError(caught));
    } }
    finally { if (scope.current === controller && !controller.signal.aborted) setPending(false); }
  };
  return <section aria-label="Bootstrap email verification" className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 text-sm">
    <h3 className="font-semibold">Verify your dashboard email</h3>
    <p className="mt-2 text-[var(--muted-foreground-2)]">Verification enables features that require confirmed email ownership. Existing dashboard access stays available.</p>
    {status ? <p className="mt-2 break-all">{status.email} · {status.emailVerified ? "Verified" : "Not verified"}</p> : pending ? <p role="status">Checking account verification…</p> : null}
    {status && !status.available && !status.emailVerified ? <p role="status" className="mt-2">{status.reason ?? "Ask the operator to configure the verified email sender."}</p> : null}
    {message ? <p role="status" className="mt-2">{message}</p> : null}
    {error ? <p role="alert" className="mt-2">{error}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      {status && !status.emailVerified ? <button type="button" className={button} onClick={() => void send()} disabled={pending || !status.available}>Send verification email</button> : null}
      <button type="button" className={button} onClick={refresh} disabled={pending}>Refresh verification status</button>
    </div>
  </section>;
}

/** Fragment proof stays in memory and never reaches an HTTP URL or DOM field. */
export function BootstrapVerificationCallback(): JSX.Element {
  const secret = useRef<string | null>(null), request = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false), [pending, setPending] = useState(false), [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const capture = () => {
      if (!window.location.hash) return;
      request.current?.abort(); request.current = null;
      const params = new URLSearchParams(window.location.hash.slice(1)), values = params.getAll("bootstrapVerification");
      const token = values.length === 1 && [...params.keys()].length === 1 ? values[0] ?? "" : "";
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      secret.current = token.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
      setReady(secret.current !== null); setPending(false); setVerified(false); setError(null);
    };
    capture(); window.addEventListener("hashchange", capture);
    return () => { window.removeEventListener("hashchange", capture); request.current?.abort(); };
  }, []);
  const confirm = async () => {
    const token = secret.current; if (!token || pending) return;
    const controller = new AbortController(); request.current = controller; setPending(true); setError(null);
    try {
      await confirmBootstrapVerification(token, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setVerified(true);
    } catch (caught) { if (request.current === controller && !controller.signal.aborted) setError(safeError(caught)); }
    finally { if (request.current === controller && !controller.signal.aborted) { secret.current = null; setReady(false); setPending(false); } }
  };
  return <main className="flex min-h-dvh items-center justify-center bg-[var(--bg)] p-4 text-[var(--fg)]">
    <section className="w-full max-w-md rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-6">
      <h1 className="text-xl font-semibold">Confirm your dashboard email</h1>
      <p className="mt-3 text-sm">This verifies only the existing account named by your email link. It does not sign you in or change permissions.</p>
      {verified ? <p role="status" className="mt-3">Email verified. Sign in or refresh your dashboard verification status.</p>
        : ready ? <button type="button" className={`${button} mt-4`} onClick={() => void confirm()} disabled={pending}>{pending ? "Confirming…" : "Confirm email"}</button>
          : <p role="status" className="mt-3">Open the original verification email link to confirm your email.</p>}
      {error ? <p role="alert" className="mt-3">{error}</p> : null}
      <a href="/app/" className="mt-4 inline-flex min-h-11 items-center underline">Return to dashboard</a>
    </section>
  </main>;
}
