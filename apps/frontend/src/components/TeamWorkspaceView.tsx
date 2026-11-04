import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type JSX } from "react";
import type {
  CreatedTeamWorkspaceInvitation,
  TeamWorkspaceDetail,
  TeamWorkspaceMembership,
  TeamWorkspaceRole,
} from "@shiba/shared";
import {
  teamWorkspaceInvitationUrl,
  teamWorkspaceRequest,
  TeamWorkspaceRequestError,
} from "../team-workspaces-client";

const BUTTON =
  "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs font-medium text-[var(--ink)] hover:bg-[var(--panel-2)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD =
  "min-h-11 min-w-0 border border-[var(--input-line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const PANEL = "min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 sm:p-5";
export interface TeamWorkspaceViewProps {
  actorId: string | null;
  workspaceId?: string;
  invitationToken?: string;
  onInvitationAccepted?: (workspaceId: string) => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onChanged?: () => void;
  onOpenChat?: () => void;
  onOpenWork?: () => void;
}

/** The keyed surface drops all previous-actor data synchronously, before effects run. */
export function TeamWorkspaceView(props: TeamWorkspaceViewProps): JSX.Element {
  const scope = `${props.actorId ?? ""}\0${props.workspaceId ?? ""}`;
  const current = useRef({ scope, token: props.invitationToken, generation: 0 });
  if (current.current.scope !== scope || current.current.token !== props.invitationToken)
    current.current = {
      scope,
      token: props.invitationToken,
      generation: current.current.generation + 1,
    };
  const generation = current.current.generation;
  return (
    <TeamWorkspaceSurface
      key={generation}
      {...props}
      isCurrent={() => current.current.generation === generation}
    />
  );
}

function TeamWorkspaceSurface({
  actorId,
  workspaceId,
  invitationToken,
  onInvitationAccepted,
  onSelectWorkspace,
  onChanged,
  onOpenChat,
  onOpenWork,
  isCurrent,
}: TeamWorkspaceViewProps & { isCurrent: () => boolean }): JSX.Element {
  const [workspace, setWorkspace] = useState<TeamWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [name, setName] = useState("");
  const nameDirty = useRef(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamWorkspaceRole>("member");
  const [createdLink, setCreatedLink] = useState<{
    url: string;
    email: string;
    invitationId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acceptedToken, setAcceptedToken] = useState<string | null>(null);
  const alive = useRef(true);
  const abort = useRef(new AbortController());
  const readEpoch = useRef(0);
  const active = () => alive.current && isCurrent() && !abort.current.signal.aborted;
  const manager = workspace?.membership.role === "owner" || workspace?.membership.role === "admin";
  const path = `/api/workspaces/${encodeURIComponent(workspaceId ?? "")}`;

  const readWorkspace = async (): Promise<TeamWorkspaceDetail | null> => {
    if (!workspaceId || !actorId) return null;
    const generation = ++readEpoch.current;
    let body: { workspace: TeamWorkspaceDetail };
    try {
      body = await teamWorkspaceRequest<{ workspace: TeamWorkspaceDetail }>(path, {
        signal: abort.current.signal,
      });
    } catch (cause) {
      if (active() && generation === readEpoch.current) throw cause;
      return null;
    }
    if (!active() || generation !== readEpoch.current) return null;
    if (
      body.workspace?.workspaceId !== workspaceId ||
      body.workspace.membership?.userId !== actorId.trim().toLowerCase()
    )
      throw new Error("Workspace membership could not be verified.");
    // Never render manager-only data even if an unexpected cache returns it to a member.
    const next =
      body.workspace.membership.role === "member"
        ? { ...body.workspace, invitations: undefined }
        : body.workspace;
    setWorkspace(next);
    if (next.membership.role !== "owner") setInviteRole("member");
    if (!nameDirty.current) setName(next.name);
    setCreatedLink((previous) =>
      previous &&
      next.membership.role !== "member" &&
      next.invitations?.some(
        (item) => item.invitationId === previous.invitationId && item.status === "pending",
      )
        ? previous
        : null,
    );
    return next;
  };

  const refreshWorkspace = useEffectEvent(async () => {
    if (busyRef.current || !workspaceId || !actorId) return;
    try {
      const next = await readWorkspace();
      if (active() && next) setError(null);
    } catch (cause) {
      if (active()) {
        setWorkspace(null);
        setCreatedLink(null);
        setError(cause instanceof Error ? cause.message : "Workspace unavailable.");
        if (cause instanceof TeamWorkspaceRequestError && [401, 403, 404].includes(cause.status))
          onChanged?.();
      }
    } finally {
      if (active()) setLoading(false);
    }
  });
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    abort.current = controller;
    void refreshWorkspace();
    const timer = setInterval(() => {
      void refreshWorkspace();
    }, 15_000);
    const onFocus = () => {
      void refreshWorkspace();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // This surface is keyed by actor/workspace. Its request controller belongs to that scope.
  }, []);

  const mutate = async (operation: () => Promise<void>) => {
    if (!actorId || !active() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    readEpoch.current++;
    try {
      await operation();
    } catch (cause) {
      if (active()) {
        setCreatedLink(null);
        setError(cause instanceof Error ? cause.message : "Workspace operation failed.");
        // Revalidate after every refusal, including stale CAS, revoked access and last-owner changes.
        if (workspaceId) {
          try {
            await readWorkspace();
          } catch {
            if (active()) setWorkspace(null);
          }
        }
        if (
          cause instanceof TeamWorkspaceRequestError &&
          (cause.status === 401 || cause.status === 403 || cause.status === 404)
        ) {
          setWorkspace(null);
          onChanged?.();
        }
      }
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const createWorkspace = (event: FormEvent) => {
    event.preventDefault();
    void mutate(async () => {
      const body = await teamWorkspaceRequest<{ workspace: TeamWorkspaceDetail }>(
        "/api/workspaces",
        {
          method: "POST",
          body: JSON.stringify({ name: name.trim() }),
          signal: abort.current.signal,
        },
      );
      if (active()) {
        onChanged?.();
        onSelectWorkspace?.(body.workspace.workspaceId);
        setNotice("Workspace created. Invite people when you are ready.");
      }
    });
  };
  const renameWorkspace = (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !manager) return;
    void mutate(async () => {
      await teamWorkspaceRequest(path, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), expectedVersion: workspace.version }),
        signal: abort.current.signal,
      });
      if (!active()) return;
      nameDirty.current = false;
      await readWorkspace();
      if (active()) {
        onChanged?.();
        setNotice("Workspace name updated.");
      }
    });
  };
  const invite = (event: FormEvent) => {
    event.preventDefault();
    if (!manager) return;
    void mutate(async () => {
      setCreatedLink(null);
      const created = await teamWorkspaceRequest<CreatedTeamWorkspaceInvitation>(
        `${path}/invitations`,
        {
          method: "POST",
          body: JSON.stringify({ email: email.trim(), role: inviteRole }),
          signal: abort.current.signal,
        },
      );
      if (!active()) return;
      const checked = await readWorkspace();
      if (
        !active() ||
        !checked ||
        checked.membership.role === "member" ||
        !checked.invitations?.some(
          (item) =>
            item.invitationId === created.invitation.invitationId && item.status === "pending",
        )
      )
        return;
      setCreatedLink({
        url: teamWorkspaceInvitationUrl(created.token, window.location.origin),
        email: created.invitation.email,
        invitationId: created.invitation.invitationId,
      });
      setEmail("");
      setNotice(
        "Invitation created. Copy and share its link with the exact email address below. No email was sent.",
      );
    });
  };
  const changeMember = (member: TeamWorkspaceMembership, role?: TeamWorkspaceRole) => {
    if (!workspace) return;
    void mutate(async () => {
      await teamWorkspaceRequest(`${path}/members/${encodeURIComponent(member.userId)}`, {
        method: role ? "PATCH" : "DELETE",
        body: JSON.stringify({ expectedVersion: member.version, ...(role ? { role } : {}) }),
        signal: abort.current.signal,
      });
      if (!active()) return;
      setCreatedLink(null);
      await readWorkspace();
      if (active()) {
        onChanged?.();
        setNotice(
          role
            ? "Member role updated."
            : "Member access removed. Previous room grants are not restored by rejoining.",
        );
      }
    });
  };
  const revoke = (invitationId: string) => {
    void mutate(async () => {
      await teamWorkspaceRequest(`${path}/invitations/${encodeURIComponent(invitationId)}`, {
        method: "DELETE",
        signal: abort.current.signal,
      });
      if (!active()) return;
      setCreatedLink(null);
      await readWorkspace();
      if (active()) setNotice("Invitation revoked. Its link can no longer be used.");
    });
  };
  const accept = () => {
    if (!invitationToken || acceptedToken === invitationToken) return;
    void mutate(async () => {
      const body = await teamWorkspaceRequest<{ workspace: TeamWorkspaceDetail }>(
        "/api/workspaces/invitations/accept",
        {
          method: "POST",
          body: JSON.stringify({ token: invitationToken }),
          signal: abort.current.signal,
        },
      );
      if (!active()) return;
      setAcceptedToken(invitationToken);
      setNotice("Invitation accepted. You can now open this workspace.");
      onChanged?.();
      onInvitationAccepted?.(body.workspace.workspaceId);
      onSelectWorkspace?.(body.workspace.workspaceId);
    });
  };
  const copyLink = () => {
    if (!createdLink || !manager) return;
    const url = createdLink.url;
    const invitationId = createdLink.invitationId;
    void mutate(async () => {
      // Recheck current membership before revealing a reusable invite through the clipboard.
      const checked = await readWorkspace();
      if (
        !active() ||
        !checked ||
        checked.membership.role === "member" ||
        !checked.invitations?.some(
          (item) => item.invitationId === invitationId && item.status === "pending",
        )
      )
        return;
      if (!navigator.clipboard?.writeText)
        throw new Error(
          "Clipboard unavailable. Open Shiba in a secure browser and allow clipboard access.",
        );
      await navigator.clipboard.writeText(url);
      if (active())
        setNotice("Invitation link copied. It is valid only for the invited email address.");
    });
  };

  const roles: TeamWorkspaceRole[] =
    workspace?.membership.role === "owner" ? ["member", "admin", "owner"] : ["member"];
  const owners = workspace?.members.filter((item) => item.role === "owner").length ?? 0;
  return (
    <section
      aria-label="Team workspace settings"
      className="flex h-full min-w-0 flex-col overflow-y-auto bg-[var(--paper)] text-[var(--ink)]"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-5 sm:px-7">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--ink-2)]">
            People · shared work · clear permissions
          </p>
          <h2 className="mt-1 text-2xl">{workspace?.name ?? "Your team workspace"}</h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--ink-2)]">
            Bring people and employees into one place. Private memory stays private; share selected
            context inside each chat.
          </p>
        </div>
        {workspace && (
          <div className="flex gap-2">
            {onOpenChat && (
              <button type="button" className={BUTTON} onClick={onOpenChat}>
                Open team chats
              </button>
            )}
            {onOpenWork && (
              <button type="button" className={BUTTON} onClick={onOpenWork}>
                View team work
              </button>
            )}
          </div>
        )}
      </header>
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 sm:p-7">
        {error && (
          <p
            role="alert"
            className="border border-[var(--danger)] p-3 text-sm text-[var(--danger)]"
          >
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="border border-[var(--line)] bg-[var(--panel-2)] p-3 text-sm">
            {notice}
          </p>
        )}
        {invitationToken && acceptedToken !== invitationToken && (
          <div className={PANEL}>
            <h3 className="text-lg">Join a workspace</h3>
            <p className="mt-2 text-sm text-[var(--ink-2)]">
              This invitation is bound to one exact email address. Acceptance uses your current
              verified account{actorId ? ` (${actorId})` : ""}. Expired, revoked, mismatched or
              already used links cannot grant access.
            </p>
            <button
              type="button"
              className={`${BUTTON} mt-4`}
              disabled={!actorId || busy}
              onClick={accept}
            >
              Accept invitation
            </button>
            {!actorId && (
              <p className="mt-2 text-xs">Sign in and verify your email before accepting.</p>
            )}
          </div>
        )}
        {!actorId ? (
          <p className={PANEL}>Sign in to manage or join a workspace.</p>
        ) : !workspaceId ? (
          <form className={PANEL} onSubmit={createWorkspace}>
            <h3 className="text-lg">Create a team workspace</h3>
            <p className="mt-2 text-sm text-[var(--ink-2)]">
              Your personal workspace remains separate. A new workspace starts with you as its owner
              and no shared private memory or app credentials.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                Workspace name
                <input
                  className={FIELD}
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <button type="submit" className={BUTTON} disabled={busy || !name.trim()}>
                Create workspace
              </button>
            </div>
          </form>
        ) : loading ? (
          <p role="status" className={PANEL}>
            Checking workspace membership…
          </p>
        ) : !workspace ? (
          <div className={PANEL}>
            <h3 className="text-lg">Workspace unavailable</h3>
            <p className="mt-2 text-sm text-[var(--ink-2)]">
              Your access may have changed. Choose another workspace or return to your personal
              workspace.
            </p>
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              onClick={() => onSelectWorkspace?.("")}
            >
              Use personal workspace
            </button>
          </div>
        ) : (
          <>
            <div className={PANEL}>
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="text-lg">Workspace details</h3>
                <span className="font-mono text-xs text-[var(--ink-2)]">
                  Your role: {workspace.membership.role}
                </span>
              </div>
              {manager ? (
                <form onSubmit={renameWorkspace} className="mt-4 flex flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                    Workspace name
                    <input
                      className={FIELD}
                      value={name}
                      maxLength={120}
                      onChange={(event) => {
                        nameDirty.current = true;
                        setName(event.target.value);
                      }}
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    className={BUTTON}
                    disabled={busy || !name.trim() || name.trim() === workspace.name}
                  >
                    Save name
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-sm text-[var(--ink-2)]">
                  Owners and admins manage workspace settings. Room access and execution approvals
                  remain separate.
                </p>
              )}
            </div>
            <div className={PANEL}>
              <div className="flex justify-between">
                <h3 className="text-lg">People</h3>
                <span className="font-mono text-xs text-[var(--ink-2)]">
                  {workspace.members.length} members
                </span>
              </div>
              <p className="mt-2 text-xs text-[var(--ink-2)]">
                Workspace membership does not automatically share private memory, app connections,
                or chat history. A workspace must retain at least one owner.
              </p>
              <ul className="mt-4 divide-y divide-[var(--line)]">
                {workspace.members.map((member) => {
                  const lastOwner = member.role === "owner" && owners < 2;
                  const canManage =
                    workspace.membership.role === "owner" ||
                    (workspace.membership.role === "admin" && member.role === "member");
                  const canLeave = member.userId === workspace.membership.userId;
                  return (
                    <li
                      key={member.userId}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="break-all text-sm">
                          {member.userId}
                          {canLeave ? " (you)" : ""}
                        </p>
                        <p className="mt-1 font-mono text-[10px] uppercase text-[var(--ink-2)]">
                          {member.role}
                          {lastOwner ? " · last owner" : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canManage && (
                          <select
                            className={FIELD}
                            aria-label={`Role for ${member.userId}`}
                            value={member.role}
                            disabled={busy || lastOwner}
                            onChange={(event) =>
                              changeMember(member, event.target.value as TeamWorkspaceRole)
                            }
                          >
                            {roles.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        )}
                        {(canManage || canLeave) && (
                          <button
                            type="button"
                            className={BUTTON}
                            disabled={busy || lastOwner}
                            onClick={() => changeMember(member)}
                          >
                            {canLeave ? "Leave workspace" : `Remove ${member.userId}`}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            {manager && (
              <div className={PANEL}>
                <h3 className="text-lg">Invite a teammate</h3>
                <p className="mt-2 text-sm text-[var(--ink-2)]">
                  Create a link for one exact email address. It expires after 24 hours. Share it
                  yourself; Shiba sends no invitation email.
                </p>
                <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                    Teammate email
                    <input
                      type="email"
                      autoComplete="off"
                      className={FIELD}
                      value={email}
                      maxLength={254}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Invitation role
                    <select
                      className={FIELD}
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value as TeamWorkspaceRole)}
                    >
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className={BUTTON} disabled={busy || !email.trim()}>
                    Create invitation link
                  </button>
                </form>
                {createdLink && (
                  <div className="mt-4 border border-[var(--line)] bg-[var(--panel-2)] p-3">
                    <p className="break-all text-sm">Invitation for {createdLink.email}</p>
                    <p className="mt-1 text-xs text-[var(--ink-2)]">
                      Copy now. This link is shown only in this session and disappears when you
                      change workspace.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className={BUTTON} disabled={busy} onClick={copyLink}>
                        Copy invitation link
                      </button>
                      <button
                        type="button"
                        className={BUTTON}
                        disabled={busy}
                        onClick={() => setCreatedLink(null)}
                      >
                        Dismiss link
                      </button>
                    </div>
                  </div>
                )}
                <ul className="mt-4 divide-y divide-[var(--line)]">
                  {workspace.invitations?.map((invitation) => (
                    <li
                      key={invitation.invitationId}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3"
                    >
                      <div className="min-w-0">
                        <p className="break-all text-sm">{invitation.email}</p>
                        <p className="mt-1 font-mono text-[10px] text-[var(--ink-2)]">
                          {invitation.role} · {invitation.status}
                        </p>
                      </div>
                      {invitation.status === "pending" &&
                        (workspace.membership.role === "owner" || invitation.role === "member") && (
                          <button
                            type="button"
                            className={BUTTON}
                            disabled={busy}
                            onClick={() => revoke(invitation.invitationId)}
                          >
                            Revoke invitation for {invitation.email}
                          </button>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
