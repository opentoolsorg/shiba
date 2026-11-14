import { useCallback, useEffect, useState, type JSX } from "react";
import { authClient } from "../../auth-client";
import { AUTH_CLIENT_TIMEOUT_MS, withAuthTimeout } from "../../auth-timeout";
import type { WhoamiWire } from "../../live-status";
import { LoadErrorState } from "../LoadErrorState";
import { Card } from "../settings-ui";

type SocialProvider = "google" | "slack";

export function AccountSettings({
  identity,
  onSignOut,
}: {
  identity: WhoamiWire;
  onSignOut?: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(identity.agent);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ token: string; userAgent?: string | null; ipAddress?: string | null }>>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [socialProviders, setSocialProviders] = useState<SocialProvider[]>([]);
  const [linking, setLinking] = useState<SocialProvider | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const result = await withAuthTimeout(authClient.listSessions(), AUTH_CLIENT_TIMEOUT_MS);
      if (result.error) {
        setSessionsError(result.error.message ?? "Could not load sessions.");
        return;
      }
      setSessions((result.data ?? []).map((row) => ({
        token: row.token,
        userAgent: row.userAgent,
        ipAddress: row.ipAddress,
      })));
    } catch {
      setSessionsError("Could not load sessions.");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (identity.auth !== "better-auth") return;
    void loadSessions();
    let cancelled = false;
    void fetch("/api/auth/social-providers", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { providers?: { google?: boolean; slack?: boolean } } : null)
      .then((result) => {
        if (!cancelled && result?.providers) {
          setSocialProviders((["google", "slack"] as const).filter((provider) => result.providers?.[provider] === true));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [identity.auth, loadSessions]);

  const saveProfile = async () => {
    setSavingProfile(true);
    setProfileNotice(null);
    try {
      const result = await withAuthTimeout(authClient.updateUser({ name: name.trim() }), AUTH_CLIENT_TIMEOUT_MS);
      if (result.error) setProfileNotice(result.error.message ?? "Profile could not be saved.");
      else setProfileNotice("Saved.");
    } catch {
      setProfileNotice("Profile could not be saved.");
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    setChangingPassword(true);
    setPasswordNotice(null);
    try {
      const result = await withAuthTimeout(authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      }), AUTH_CLIENT_TIMEOUT_MS);
      if (result.error) setPasswordNotice(result.error.message ?? "Password could not be changed.");
      else {
        setPasswordNotice("Password updated.");
        setCurrentPassword("");
        setNewPassword("");
        await loadSessions();
      }
    } catch {
      setPasswordNotice("Password could not be changed.");
    } finally {
      setChangingPassword(false);
    }
  };

  const revokeSession = async (sessionToken: string) => {
    setRevoking(sessionToken);
    try {
      await withAuthTimeout(authClient.revokeSession({ token: sessionToken }), AUTH_CLIENT_TIMEOUT_MS);
      await loadSessions();
    } finally {
      setRevoking(null);
    }
  };

  const linkSocial = async (provider: SocialProvider) => {
    setLinking(provider);
    setLinkError(null);
    try {
      const result = await authClient.linkSocial({ provider, callbackURL: "/app/?auth_linked=1", errorCallbackURL: "/app/?auth_link_error=1" });
      if (result.error) setLinkError("The account could not be linked. Use the provider with the same verified email as this account.");
    } catch {
      setLinkError("The account link could not be confirmed.");
    } finally {
      setLinking(null);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      if (onSignOut) await onSignOut();
      else {
        await authClient.signOut().catch(() => {});
        window.location.reload();
      }
    } finally {
      setSigningOut(false);
    }
  };

  if (identity.auth !== "better-auth") {
    return (
      <Card>
        <div className="px-4 py-4 text-xs text-[var(--muted-foreground-2)]">
          Built-in account controls are available only on the Better Auth dashboard lane.
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="border-b border-[var(--border-1)] px-4 py-3 text-xs font-semibold text-[var(--fg)]">Profile</div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
            Display name
            <input value={name} onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--fg)]" />
          </label>
          <button type="button" disabled={savingProfile} onClick={() => void saveProfile()}
            className="self-start min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 text-xs font-semibold disabled:opacity-60">
            {savingProfile ? "Saving…" : "Save profile"}
          </button>
          {profileNotice ? <p className="text-xs text-[var(--muted-foreground-2)]">{profileNotice}</p> : null}
        </div>
      </Card>

      <Card>
        <div className="border-b border-[var(--border-1)] px-4 py-3 text-xs font-semibold text-[var(--fg)]">Password</div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <input type="password" autoComplete="current-password" placeholder="Current password" value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm" />
          <input type="password" autoComplete="new-password" placeholder="New password" value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="w-full min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm" />
          <button type="button" disabled={changingPassword || !currentPassword || newPassword.length < 8}
            onClick={() => void changePassword()}
            className="self-start min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 text-xs font-semibold disabled:opacity-60">
            {changingPassword ? "Updating…" : "Change password"}
          </button>
          {passwordNotice ? <p className="text-xs text-[var(--muted-foreground-2)]">{passwordNotice}</p> : null}
        </div>
      </Card>

      <Card>
        <div className="border-b border-[var(--border-1)] px-4 py-3 text-xs font-semibold text-[var(--fg)]">Active sessions</div>
        {sessionsLoading ? <p className="px-4 py-3 text-xs text-[var(--muted-foreground-2)]">Loading sessions…</p> : null}
        {sessionsError ? <div className="px-4 py-3"><LoadErrorState message={sessionsError} onRetry={() => void loadSessions()} /></div> : null}
        {!sessionsLoading && !sessionsError ? (
          <ul className="divide-y divide-[var(--border-1)]">
            {sessions.map((session) => (
              <li key={session.token} className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-[var(--fg)]">{session.userAgent ?? "Unknown browser"}</div>
                  <div className="truncate text-[10px] text-[var(--muted-foreground-2)]">{session.ipAddress ?? "Unknown network"}</div>
                </div>
                <button type="button" disabled={revoking === session.token} onClick={() => void revokeSession(session.token)}
                  className="shrink-0 min-h-9 rounded-[var(--radius-button)] border border-[var(--border-1)] px-2 text-[10px] font-semibold disabled:opacity-60">
                  {revoking === session.token ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {socialProviders.length > 0 ? (
        <Card>
          <div className="border-b border-[var(--border-1)] px-4 py-3 text-xs font-semibold text-[var(--fg)]">Connected sign-in methods</div>
          <div className="flex flex-wrap gap-2 px-4 py-3">
            {socialProviders.map((provider) => (
              <button key={provider} type="button" disabled={linking !== null} onClick={() => void linkSocial(provider)}
                className="min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 text-xs font-semibold disabled:opacity-60">
                {linking === provider ? "Opening…" : `Link ${provider === "google" ? "Google" : "Slack"}`}
              </button>
            ))}
          </div>
          {linkError ? <p role="alert" className="px-4 pb-3 text-xs text-[var(--destructive)]">{linkError}</p> : null}
          <p className="px-4 pb-3 text-[11px] text-[var(--muted-foreground-2)]">
            Account linking signs you in with an existing verified email. Shiba does not install a Slack app for dashboard login unless your operator enabled the Slack provider.
          </p>
        </Card>
      ) : null}

      <Card>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="text-xs text-[var(--muted-foreground-2)]">Sign out of this dashboard session.</div>
          <button type="button" onClick={() => void signOut()} disabled={signingOut}
            className="shrink-0 rounded-[var(--radius-button)] border border-[var(--destructive)]/50 bg-[var(--destructive-soft)] px-3 py-1.5 text-[11px] font-semibold text-[var(--destructive)] disabled:opacity-60">
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </Card>
    </div>
  );
}