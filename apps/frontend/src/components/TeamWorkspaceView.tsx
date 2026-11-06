import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type JSX } from "react";
import { Building2, Check, Copy, Shield, UserPlus, Users, X } from "lucide-react";
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

const BUTTON_PRIMARY =
  "h-9 px-3.5 rounded-lg bg-[#0a0a0a] dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-[#27272a] dark:hover:bg-zinc-200 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 inline-flex items-center justify-center gap-1.5";
const BUTTON_SECONDARY =
  "h-9 px-3 rounded-lg border border-[#e4e4e7] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-[#0a0a0a] dark:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-700/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50 inline-flex items-center justify-center gap-1.5";
const BUTTON_DANGER =
  "h-9 px-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-950/20 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100/70 dark:hover:bg-red-900/40 transition-colors disabled:cursor-not-allowed disabled:opacity-50 inline-flex items-center justify-center gap-1.5";
const FIELD =
  "h-9 min-w-0 rounded-lg border border-[#e4e4e7] dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 text-xs text-[#0a0a0a] dark:text-zinc-100 placeholder-[#71717a] focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 disabled:opacity-50";
const PANEL =
  "min-w-0 rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-xs";

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

export type TeamWorkspaceTab = "people" | "invitations" | "roles" | "settings";

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
  const [activeTab, setActiveTab] = useState<TeamWorkspaceTab>("people");
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
      className="flex h-full min-w-0 flex-col overflow-y-auto bg-[#fafafa] dark:bg-[#0c0c0e] text-[#0a0a0a] dark:text-zinc-100"
    >
      {/* Workspace header */}
      <header className="border-b border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-[#121214] px-6 py-5 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900 border border-[#e4e4e7] dark:border-zinc-700 text-[#0a0a0a] dark:text-zinc-100 font-semibold text-base shadow-2xs">
              {workspace?.name ? workspace.name.charAt(0).toUpperCase() : <Building2 className="size-5" aria-hidden="true" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight text-[#0a0a0a] dark:text-zinc-100 truncate">
                  {workspace?.name ?? "Your team workspace"}
                </h2>
                {workspace?.membership.role ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#f4f4f5] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-200 capitalize border border-[#e4e4e7] dark:border-zinc-700">
                    {workspace.membership.role}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
                Workspace · {workspace?.members ? `${workspace.members.length} member${workspace.members.length === 1 ? "" : "s"}` : "Multiplayer"}
              </p>
            </div>
          </div>

          {workspace ? (
            <div className="flex items-center gap-2">
              {onOpenChat ? (
                <button type="button" className={BUTTON_SECONDARY} onClick={onOpenChat}>
                  Open team chats
                </button>
              ) : null}
              {onOpenWork ? (
                <button type="button" className={BUTTON_SECONDARY} onClick={onOpenWork}>
                  View team work
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Workspace tabs */}
        {workspace ? (
          <div role="tablist" aria-label="Workspace tabs" className="flex items-center gap-1 border-t border-[#e4e4e7] dark:border-zinc-800 mt-5 pt-3 -mb-2">
            {(
              [
                { id: "people", label: "People", count: workspace.members.length },
                ...(manager ? [{ id: "invitations", label: "Invitations", count: workspace.invitations?.length ?? 0 }] : []),
                { id: "roles", label: "Roles & permissions" },
                { id: "settings", label: "General" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id as TeamWorkspaceTab)}
                className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === tab.id
                    ? "bg-[#e4e4e7] text-[#0a0a0a] dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100"
                }`}
              >
                <span>{tab.label}</span>
                {"count" in tab && tab.count !== undefined ? (
                  <span className="text-[11px] text-[#71717a] dark:text-zinc-500 font-mono">({tab.count})</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="mx-auto grid w-full max-w-5xl gap-5 p-6">
        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/70 dark:bg-red-950/20 p-3.5 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 text-xs text-[#0a0a0a] dark:text-zinc-200 shadow-xs"
          >
            {notice}
          </p>
        ) : null}

        {invitationToken && acceptedToken !== invitationToken ? (
          <div className={PANEL}>
            <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Join a workspace</h3>
            <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
              This invitation is bound to one exact email address. Acceptance uses your current
              verified account{actorId ? ` (${actorId})` : ""}. Expired, revoked, mismatched or
              already used links cannot grant access.
            </p>
            <div className="mt-4">
              <button
                type="button"
                className={BUTTON_PRIMARY}
                disabled={!actorId || busy}
                onClick={accept}
              >
                Accept invitation
              </button>
            </div>
            {!actorId ? (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Sign in and verify your email before accepting.</p>
            ) : null}
          </div>
        ) : null}

        {!actorId ? (
          <div className={PANEL}>
            <p className="text-xs text-[#71717a] dark:text-zinc-400">Sign in to manage or join a workspace.</p>
          </div>
        ) : !workspaceId ? (
          <form className={PANEL} onSubmit={createWorkspace}>
            <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Create a team workspace</h3>
            <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
              Your personal workspace remains separate. A new workspace starts with you as its owner
              and no shared private memory or app credentials.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-2.5">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">
                Workspace name
                <input
                  className={FIELD}
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Acme Corp"
                  required
                />
              </label>
              <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !name.trim()}>
                Create workspace
              </button>
            </div>
          </form>
        ) : loading ? (
          <div className={PANEL}>
            <p role="status" className="text-xs text-[#71717a] dark:text-zinc-400">
              Checking workspace membership…
            </p>
          </div>
        ) : !workspace ? (
          <div className={PANEL}>
            <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Workspace unavailable</h3>
            <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
              Your access may have changed. Choose another workspace or return to your personal
              workspace.
            </p>
            <div className="mt-4">
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => onSelectWorkspace?.("")}
              >
                Use personal workspace
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* General Settings Tab (Workspace name & info) */}
            <div className={`${PANEL} ${activeTab === "settings" ? "block" : "hidden"}`}>
              <div className="flex flex-wrap justify-between gap-2 border-b border-[#e4e4e7] dark:border-zinc-800 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Workspace details</h3>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
                    Workspace identification and settings
                  </p>
                </div>
                <span className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
                  Your role: {workspace.membership.role}
                </span>
              </div>
              {manager ? (
                <form onSubmit={renameWorkspace} className="mt-4 flex flex-wrap items-end gap-2.5">
                  <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">
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
                    className={BUTTON_PRIMARY}
                    disabled={busy || !name.trim() || name.trim() === workspace.name}
                  >
                    Save name
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-xs text-[#71717a] dark:text-zinc-400">
                  Owners and admins manage workspace settings. Room access and execution approvals
                  remain separate.
                </p>
              )}
            </div>

            {/* People Tab (Members list) */}
            <div className={`${PANEL} ${activeTab === "people" ? "block" : "hidden"}`}>
              <div className="flex items-center justify-between border-b border-[#e4e4e7] dark:border-zinc-800 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">People</h3>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
                    Team members with access to this workspace
                  </p>
                </div>
                <span className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
                  {workspace.members.length} member{workspace.members.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="mt-2 text-xs text-[#71717a] dark:text-zinc-400">
                Workspace membership does not automatically share private memory, app connections,
                or chat history. A workspace must retain at least one owner.
              </p>
              <ul className="mt-4 divide-y divide-[#e4e4e7]/60 dark:divide-zinc-800/60 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg overflow-hidden">
                {workspace.members.map((member) => {
                  const lastOwner = member.role === "owner" && owners < 2;
                  const canManage =
                    workspace.membership.role === "owner" ||
                    (workspace.membership.role === "admin" && member.role === "member");
                  const canLeave = member.userId === workspace.membership.userId;
                  return (
                    <li
                      key={member.userId}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3 bg-white dark:bg-zinc-900"
                    >
                      <div className="min-w-0">
                        <p className="break-all text-xs font-medium text-[#0a0a0a] dark:text-zinc-100">
                          {member.userId}
                          {canLeave ? " (you)" : ""}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] text-[#71717a] dark:text-zinc-400 capitalize">
                          {member.role}
                          {lastOwner ? " · last owner" : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {canManage ? (
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
                        ) : null}
                        {canManage || canLeave ? (
                          <button
                            type="button"
                            className={canLeave ? BUTTON_SECONDARY : BUTTON_DANGER}
                            disabled={busy || lastOwner}
                            onClick={() => changeMember(member)}
                          >
                            {canLeave ? "Leave workspace" : `Remove ${member.userId}`}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Invitations Tab (Invite teammate + pending list) */}
            {manager ? (
              <div className={`${PANEL} ${activeTab === "invitations" ? "block" : "hidden"}`}>
                <div className="border-b border-[#e4e4e7] dark:border-zinc-800 pb-3">
                  <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Invite a teammate</h3>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
                    Create a link for one exact email address. It expires after 24 hours. Share it
                    yourself; Shiba sends no invitation email.
                  </p>
                </div>
                <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-2.5">
                  <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">
                    Teammate email
                    <input
                      type="email"
                      autoComplete="off"
                      className={FIELD}
                      value={email}
                      maxLength={254}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="teammate@example.com"
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">
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
                  <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !email.trim()}>
                    Create invitation link
                  </button>
                </form>

                {createdLink ? (
                  <div className="mt-4 rounded-lg border border-[#e4e4e7] dark:border-zinc-800 bg-[#f4f4f5]/60 dark:bg-zinc-800/40 p-4">
                    <p className="break-all text-xs font-medium text-[#0a0a0a] dark:text-zinc-100">
                      Invitation for {createdLink.email}
                    </p>
                    <p className="mt-1 text-[11px] text-[#71717a] dark:text-zinc-400">
                      Copy now. This link is shown only in this session and disappears when you
                      change workspace.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={copyLink}>
                        <Copy className="size-3.5" aria-hidden="true" />
                        Copy invitation link
                      </button>
                      <button
                        type="button"
                        className={BUTTON_SECONDARY}
                        disabled={busy}
                        onClick={() => setCreatedLink(null)}
                      >
                        Dismiss link
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-5 pt-4 border-t border-[#e4e4e7] dark:border-zinc-800">
                  <h4 className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-100 mb-2">Pending invitations</h4>
                  {workspace.invitations && workspace.invitations.length > 0 ? (
                    <ul className="divide-y divide-[#e4e4e7]/60 dark:divide-zinc-800/60 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg overflow-hidden">
                      {workspace.invitations.map((invitation) => (
                        <li
                          key={invitation.invitationId}
                          className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3 bg-white dark:bg-zinc-900"
                        >
                          <div className="min-w-0">
                            <p className="break-all text-xs font-medium text-[#0a0a0a] dark:text-zinc-100">
                              {invitation.email}
                            </p>
                            <p className="mt-0.5 font-mono text-[11px] text-[#71717a] dark:text-zinc-400 capitalize">
                              {invitation.role} · {invitation.status}
                            </p>
                          </div>
                          {invitation.status === "pending" &&
                          (workspace.membership.role === "owner" || invitation.role === "member") ? (
                            <button
                              type="button"
                              className={BUTTON_DANGER}
                              disabled={busy}
                              onClick={() => revoke(invitation.invitationId)}
                            >
                              Revoke invitation for {invitation.email}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[#71717a] dark:text-zinc-500 py-2">No pending invitations.</p>
                  )}
                </div>
              </div>
            ) : null}

            {/* Roles & Permissions Tab */}
            <div className={`${PANEL} ${activeTab === "roles" ? "block" : "hidden"}`}>
              <div className="border-b border-[#e4e4e7] dark:border-zinc-800 pb-3">
                <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Roles & permissions</h3>
                <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
                  Built-in roles and access levels in Shiba workspaces
                </p>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-lg border border-[#e4e4e7] dark:border-zinc-800 p-3.5 bg-white dark:bg-zinc-900">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">
                      Owner
                    </span>
                    <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Full workspace control</span>
                  </div>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-1">
                    Can rename workspace, invite any role, modify or remove admins and members, and delete/transfer ownership. Workspaces must have at least one owner.
                  </p>
                </div>
                <div className="rounded-lg border border-[#e4e4e7] dark:border-zinc-800 p-3.5 bg-white dark:bg-zinc-900">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                      Admin
                    </span>
                    <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Team manager</span>
                  </div>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-1">
                    Can invite members, change member roles, and remove members. Cannot modify owner accounts or rename the workspace.
                  </p>
                </div>
                <div className="rounded-lg border border-[#e4e4e7] dark:border-zinc-800 p-3.5 bg-white dark:bg-zinc-900">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      Member
                    </span>
                    <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Standard collaborator</span>
                  </div>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-1">
                    Can participate in team chats, view shared work, and leave the workspace. Cannot invite new users or edit roles.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
