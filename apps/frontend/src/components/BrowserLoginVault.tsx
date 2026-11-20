import type { TeamWorkspaceRole } from "@shiba/shared";
import { Copy, KeyRound, Plus } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useId, useRef, useState } from "react";
import { teamWorkspaceHeaders } from "../team-workspaces-client";
import { ToneChip } from "./ToneChip";

type SavedLogin = { id: string; origin: string; label: string; username: string };
type LoginFields = Partial<Omit<SavedLogin, "id"> & { password: string; totpSecret: string | null }>;

const BUTTON = "inline-flex min-h-11 items-center gap-1.5 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs font-medium text-[var(--ink)] [@media(hover:hover)]:hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50";
const FIELD = "min-h-11 w-full min-w-0 border border-[var(--input-line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";

function loginOrigin(value: string): string | null {
  if (!/^https:\/\/[^/?#]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.pathname !== "/" || url.username || url.password || url.hostname.includes("*") ? null : url.origin;
  } catch {
    return null;
  }
}

function safeLoginList(value: unknown): SavedLogin[] {
  if (!value || typeof value !== "object" || !("logins" in value) || !Array.isArray(value.logins)) {
    throw new Error("Invalid saved login list");
  }
  return value.logins.flatMap((row: Partial<SavedLogin> | null) => {
    if (!row || typeof row.id !== "string" || typeof row.label !== "string" ||
      typeof row.origin !== "string" || typeof row.username !== "string") return [];
    return [{ id: row.id, label: row.label, origin: row.origin, username: row.username }];
  });
}

export function BrowserLoginVault({
  workspaceId,
  workspaceName,
  workspaceRole,
}: {
  workspaceId?: string;
  workspaceName?: string;
  workspaceRole?: TeamWorkspaceRole;
}): JSX.Element {
  return <ScopedBrowserLoginVault key={`${workspaceId ?? "personal"}:${workspaceRole ?? ""}`} workspaceId={workspaceId}
    workspaceName={workspaceName} canManage={!workspaceId || workspaceRole === "owner" || workspaceRole === "admin"} />;
}

function ScopedBrowserLoginVault({ workspaceId, workspaceName, canManage }: {
  workspaceId?: string;
  workspaceName?: string;
  canManage: boolean;
}): JSX.Element {
  const titleId = useId();
  const [logins, setLogins] = useState<SavedLogin[]>([]);
  const [form, setForm] = useState<"new" | SavedLogin | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [clearTotp, setClearTotp] = useState(false);
  const [loading, setLoading] = useState(canManage);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const labelField = useRef<HTMLInputElement>(null);
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    setLoading(true);
    setLoadError(null);
    void fetch(`/api/browser-logins${query}`, {
      cache: "no-store", credentials: "same-origin", headers: teamWorkspaceHeaders(workspaceId), signal,
    }).then(async (response) => {
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("You don’t have access to these saved logins.");
        throw new Error("Saved logins couldn’t be loaded.");
      }
      const rows = safeLoginList(await response.json());
      if (!controller.signal.aborted) setLogins(rows);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLogins([]);
      setForm(null);
      setConfirmRemoveId(null);
      setLoadError(error instanceof Error && error.message === "You don’t have access to these saved logins."
        ? error.message : "Saved logins couldn’t be loaded.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [canManage, query, revision, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (form) labelField.current?.focus();
  }, [form]);

  const openForm = (next: typeof form) => {
    setForm(next);
    setConfirmRemoveId(null);
    setClearTotp(false);
    setActionError(null);
    setNotice(null);
  };

  const mutate = async (method: "POST" | "PATCH" | "DELETE", id?: string, fields?: LoginFields) => {
    const current = lifetime.current;
    if (!canManage || !current || current.signal.aborted || saving.current) return;
    saving.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/browser-logins${id ? `/${encodeURIComponent(id)}` : ""}${query}`, {
        method,
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(12_000)]),
        headers: { ...teamWorkspaceHeaders(workspaceId), ...(fields ? { "Content-Type": "application/json" } : {}) },
        ...(fields ? { body: JSON.stringify(fields) } : {}),
      });
      if (current.signal.aborted) return;
      if (!response.ok) {
        setActionError(response.status === 401 || response.status === 403
          ? "You don’t have permission to change this vault."
          : response.status === 503 ? "The vault is unavailable. Ask the deployment operator to check its configuration."
          : response.status === 409 || response.status === 404 ? "This saved login changed or was removed. Reopen the vault before trying again."
          : method === "DELETE" ? "The login couldn’t be removed. Try again." : "The login couldn’t be saved. Check the site, password, and TOTP settings, then try again.");
        return;
      }
      openForm(null);
      setNotice(method === "DELETE" ? "Saved login removed." : method === "POST" ? "Browser login saved." : "Saved login updated.");
      setRevision((value) => value + 1);
    } catch {
      if (!current.signal.aborted) setActionError("The vault couldn’t be reached. Try again.");
    } finally {
      saving.current = false;
      if (!current.signal.aborted) setBusy(false);
    }
  };

  const edit = form === "new" ? null : form;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || saving.current) return;
    const element = event.currentTarget;
    const data = new FormData(element);
    const origin = loginOrigin(String(data.get("origin")).trim());
    const label = String(data.get("label")).trim();
    const username = String(data.get("username"));
    const password = String(data.get("password") ?? "");
    const totp = String(data.get("totpSecret") ?? "").trim();
    setNotice(null);
    if (!origin || !label || !username.trim()) {
      setActionError("Enter a label, username, and exact HTTPS site origin without a path, query, or wildcard.");
      return;
    }
    if (totp && !/^[A-Z2-7]{16,128}$/.test(totp.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, ""))) {
      setActionError("Enter the Base32 TOTP setup key, not a six-digit code.");
      return;
    }
    if ((edit && origin !== edit.origin && (!password || (!totp && !clearTotp))) || (!edit && !password)) {
      setActionError(edit ? "Changing the site origin requires a new password and either a new TOTP key or clearing the old key." : "Enter the password for this saved login.");
      return;
    }
    const fields: LoginFields = {
      ...(origin !== edit?.origin ? { origin } : {}),
      ...(label !== edit?.label ? { label } : {}),
      ...(username !== edit?.username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(clearTotp ? { totpSecret: null } : totp ? { totpSecret: totp } : {}),
    };
    if (!Object.keys(fields).length) {
      setActionError("There are no changes to save.");
      return;
    }
    const passwordField = element.elements.namedItem("password") as HTMLInputElement;
    const totpField = element.elements.namedItem("totpSecret") as HTMLInputElement;
    passwordField.value = "";
    totpField.value = "";
    void mutate(edit ? "PATCH" : "POST", edit?.id, fields);
  };

  return (
    <section aria-labelledby={titleId} className="min-w-0 border border-[var(--line)] bg-[var(--card)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="inline-flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
              <KeyRound className="size-4 shrink-0 text-[var(--primary)]" aria-hidden="true" /> Browser logins
            </h3>
            <ToneChip tone="neutral" label={workspaceId ? workspaceName ?? "Team vault" : "Personal vault"} />
          </div>
          <p className="mt-1.5 text-sm text-[var(--ink-2)]">Save sign-in details for one HTTPS site. Passwords and TOTP keys aren’t shown after saving.</p>
        </div>
        {canManage && !loadError ? (
          <button type="button" className={`${BUTTON} border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)] [@media(hover:hover)]:hover:bg-[var(--primary)] [@media(hover:hover)]:hover:opacity-90`}
            disabled={busy || loading || form === "new"} onClick={() => openForm("new")}>
            <Plus className="size-4" aria-hidden="true" /> Add login
          </button>
        ) : null}
      </div>

      {!canManage ? <p className="px-4 py-4 text-sm text-[var(--ink-2)] sm:px-5">Only workspace owners and admins can manage browser logins.</p> : (
        <>
          <p className="border-b border-[var(--line)] bg-[var(--panel-2)] px-4 py-3 text-xs text-[var(--ink-2)] sm:px-5">
            {workspaceId ? "Copy the login ID, then use Browser in your private Chat and ask Shiba to sign in with it." : "In Chat, turn on Browser and ask Shiba to sign in with the login ID."} Every saved sign-in requires approval.
          </p>
          {notice ? <p role="status" className="px-4 pt-3 text-xs text-[var(--success)] sm:px-5">{notice}</p> : null}
          {actionError ? <p role="alert" className="px-4 pt-3 text-xs text-[var(--destructive-fg)] sm:px-5">{actionError}</p> : null}
          {loadError ? <div className="flex flex-wrap items-center gap-3 p-4 sm:px-5">
            <p role="alert" className="text-sm text-[var(--destructive-fg)]">{loadError}</p>
            <button type="button" className={BUTTON} onClick={() => setRevision((value) => value + 1)}>Retry</button>
          </div> : null}
          {loading && !logins.length ? <p role="status" className="p-4 text-sm text-[var(--ink-2)] sm:px-5">Loading browser logins…</p> : null}
          {!loading && !loadError && !logins.length && !form ? <p className="p-4 text-sm text-[var(--ink-2)] sm:px-5">No saved browser logins yet.</p> : null}

          {form ? (
            <form key={edit?.id ?? "new"} aria-label={edit ? "Edit browser login" : "Add browser login"} autoComplete="off" onSubmit={submit}
              className="border-b border-[var(--line)] px-4 py-4 sm:px-5">
              <h4 className="mb-3 text-sm font-semibold text-[var(--ink)]">{edit ? `Edit ${edit.label}` : "Add a browser login"}</h4>
              <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1 text-xs text-[var(--ink-2)]">Label
                  <input ref={labelField} name="label" defaultValue={edit?.label} placeholder="Example Portal" required className={FIELD} maxLength={120} />
                </label>
                <label className="grid min-w-0 gap-1 text-xs text-[var(--ink-2)]">Site origin
                  <input name="origin" type="url" defaultValue={edit?.origin} placeholder="https://portal.example.com" required className={FIELD} maxLength={300} />
                </label>
                <label className="grid min-w-0 gap-1 text-xs text-[var(--ink-2)]">Username
                  <input name="username" defaultValue={edit?.username} required className={FIELD} maxLength={320} autoCapitalize="none" spellCheck={false} />
                </label>
                <label className="grid min-w-0 gap-1 text-xs text-[var(--ink-2)]">Password
                  <input name="password" type="password" placeholder={edit ? "Leave blank to keep" : undefined} required={!edit} autoComplete="new-password" className={FIELD} maxLength={2048} />
                </label>
                <label className="grid min-w-0 gap-1 text-xs text-[var(--ink-2)]">TOTP setup key (optional)
                  <input name="totpSecret" type="password" placeholder={edit ? "Leave blank to keep" : "Base32 key, not a one-time code"} disabled={clearTotp} autoComplete="new-password" className={FIELD} maxLength={256} />
                </label>
                {edit ? <label className="flex min-h-11 items-center gap-2 self-end text-xs text-[var(--ink-2)]">
                  <input type="checkbox" checked={clearTotp} onChange={(event) => setClearTotp(event.target.checked)} /> Clear saved TOTP key
                </label> : null}
                {edit ? <p className="text-xs text-[var(--ink-2)] sm:col-span-2">Changing the site requires a new password and replacing or clearing the TOTP key.</p> : null}
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <button type="submit" className={BUTTON}>{busy ? "Saving…" : "Save login"}</button>
                  <button type="button" className={BUTTON} onClick={() => openForm(null)}>Cancel</button>
                </div>
              </fieldset>
            </form>
          ) : null}

          {logins.length ? <ul aria-label="Saved browser logins" className="divide-y divide-[var(--line)]">
            {logins.map((login) => (
              <li key={login.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
                <div className="min-w-0 flex-1 basis-56">
                  <h4 className="break-words text-sm font-semibold text-[var(--ink)]">{login.label}</h4>
                  <p className="mt-1 break-all text-xs text-[var(--ink-2)]">{login.origin} · {login.username}</p>
                  <p className="mt-1 break-all text-xs text-[var(--ink-2)]">Login ID: <code>{login.id}</code></p>
                </div>
                {confirmRemoveId === login.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[var(--ink-2)]">Remove this saved login?</span>
                    <button type="button" className={`${BUTTON} text-[var(--destructive-fg)]`} disabled={busy} onClick={() => { void mutate("DELETE", login.id); }}>Confirm remove</button>
                    <button type="button" className={BUTTON} disabled={busy} onClick={() => setConfirmRemoveId(null)}>Cancel</button>
                  </div>
                ) : <div className="flex flex-wrap gap-2">
                  <button type="button" className={BUTTON} aria-label={`Copy login ID for ${login.label}`} onClick={async () => {
                    const current = lifetime.current;
                    try {
                      await navigator.clipboard.writeText(login.id);
                      if (current && !current.signal.aborted) setNotice("Login ID copied.");
                    } catch {
                      if (current && !current.signal.aborted) setNotice("Clipboard unavailable. Select and copy the login ID above.");
                    }
                  }}><Copy className="size-3.5" aria-hidden="true" /> Copy ID</button>
                  <button type="button" className={BUTTON} aria-label={`Edit ${login.label}`} disabled={busy} onClick={() => openForm(login)}>Edit</button>
                  <button type="button" className={BUTTON} aria-label={`Remove ${login.label}`} disabled={busy} onClick={() => {
                    openForm(null);
                    setConfirmRemoveId(login.id);
                  }}>Remove</button>
                </div>}
              </li>
            ))}
          </ul> : null}
        </>
      )}
    </section>
  );
}
