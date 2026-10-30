import { type FormEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";

interface Room {
  roomId: string;
  title: string;
  visibility: "private" | "shared";
  memberCount?: number;
}

interface Member {
  roomId: string;
  userId: string;
  displayName: string;
  actorId: string;
  actorKind: "human" | "agent";
  role: "owner" | "member" | "agent";
  status: "active" | "removed";
}

interface Message {
  messageId: string;
  senderUserId: string;
  senderActorId: string;
  senderKind: "human" | "agent";
  body: string;
  createdAt: number;
  sourceRunId?: string;
  sourceArtifactRefs?: Array<{
    index: number;
    path: string;
    artifactId?: string;
    version?: number;
    sha256?: string;
  }>;
}

interface Handoff {
  handoffId: string;
  taskId: string;
  senderActorId: string;
  recipientActorId: string;
  parentHandoffId: string | null;
  depth: number;
  remainingBudget: number;
  status: "active" | "cancelled";
  createdAt: number;
  approvalId?: string;
  runId?: string;
  execution?: {
    approvalStatus?: string;
    runStatus?: string;
    summary?: string;
    error?: string;
    pullUrl?: string;
    unavailable?: boolean;
  };
}

interface EmployeeProfile {
  id: string;
  version: number;
  slug: string;
  config: { name: string; emoji?: string; defaultRepoUrl?: string };
}

interface RoomDetail {
  room: Room;
  currentUserId: string;
  members: Member[];
  messages: Message[];
  handoffs: Handoff[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw new CollaborationApiError(
      response.status,
      payload.error ?? `Request failed (${response.status})`,
    );
  return payload;
}

class CollaborationApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationApiError";
  }
}

function isMembershipLost(error: unknown): boolean {
  return error instanceof CollaborationApiError && [401, 403, 404].includes(error.status);
}

function request(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

export function CollaborationView(): JSX.Element {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState("");
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [roomTitle, setRoomTitle] = useState("");
  const [roomVisibility, setRoomVisibility] = useState<"private" | "shared">("private");
  const [inviteUserId, setInviteUserId] = useState("");
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [recipientActorId, setRecipientActorId] = useState("");
  const [parentHandoffId, setParentHandoffId] = useState("");
  const [profiles, setProfiles] = useState<EmployeeProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [handoffRequestId, setHandoffRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryableError, setRetryableError] = useState(false);

  const refresh = useCallback(
    async (roomId = activeRoomId) => {
      const listed = await api<{ rooms: Room[] }>("/api/collaboration/rooms");
      setRooms(listed.rooms);
      const selected = roomId || listed.rooms[0]?.roomId || "";
      setActiveRoomId(selected);
      if (!selected) {
        setDetail(null);
        return;
      }
      const loaded = await api<RoomDetail>(
        `/api/collaboration/rooms/${encodeURIComponent(selected)}`,
      );
      setDetail(loaded);
    },
    [activeRoomId],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const listed = await api<{ rooms: Room[] }>("/api/collaboration/rooms");
        if (cancelled) return;
        setRooms(listed.rooms);
        const selected = activeRoomId || listed.rooms[0]?.roomId || "";
        setActiveRoomId(selected);
        if (selected) {
          const loaded = await api<RoomDetail>(
            `/api/collaboration/rooms/${encodeURIComponent(selected)}`,
          );
          if (!cancelled) setDetail(loaded);
        } else if (!cancelled) setDetail(null);
        if (!cancelled) setError("");
        if (!cancelled) setRetryableError(false);
      } catch (cause) {
        if (!cancelled && isMembershipLost(cause)) {
          setDetail(null);
          setActiveRoomId("");
          setError(
            "Access to this room ended. Its contents are no longer available in this session.",
          );
          setRetryableError(false);
        } else if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRetryableError(true);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRoomId]);

  useEffect(() => {
    let cancelled = false;
    void api<{ agents: EmployeeProfile[] }>("/api/custom-agents")
      .then((result) => {
        if (!cancelled) setProfiles(result.agents);
      })
      .catch(() => {
        // Profile listing is ancillary: room reading remains available.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const members = useMemo(() => detail?.members ?? [], [detail]);
  const effectiveActorId =
    members.find(
      (member) => member.userId === detail?.currentUserId && member.actorKind === "human",
    )?.actorId || "";
  const recipients = members.filter((member) => member.actorId !== effectiveActorId);
  const parentHandoffs = (detail?.handoffs ?? []).filter(
    (handoff) =>
      handoff.status === "active" &&
      handoff.recipientActorId === effectiveActorId &&
      handoff.taskId === taskId.trim(),
  );
  const canManageMembers = members.some(
    (member) => member.role === "owner" && member.userId === detail?.currentUserId,
  );

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh(activeRoomId);
    } catch (cause) {
      if (isMembershipLost(cause)) {
        setDetail(null);
        setActiveRoomId("");
        setError(
          "Access to this room ended. Its contents are no longer available in this session.",
        );
        setRetryableError(false);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
        setRetryableError(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const createRoom = (event: FormEvent) => {
    event.preventDefault();
    if (!roomTitle.trim()) return;
    void (async () => {
      setBusy(true);
      setError("");
      setRetryableError(false);
      try {
        const result = await api<{ room: Room }>(
          "/api/collaboration/rooms",
          request("POST", { title: roomTitle, visibility: roomVisibility }),
        );
        setRoomTitle("");
        await refresh(result.room.roomId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setRetryableError(!(cause instanceof CollaborationApiError));
      } finally {
        setBusy(false);
      }
    })();
  };

  const inviteMember = (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !inviteUserId.trim()) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/members`,
        request("POST", { userId: inviteUserId.trim() }),
      );
      setInviteUserId("");
    });
  };

  const addAgent = () => {
    if (!activeRoomId || !selectedProfileId) return;
    const profile = profiles.find((item) => item.id === selectedProfileId);
    if (!profile) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/agents`,
        request("POST", { profileId: profile.id, profileVersion: profile.version }),
      );
    });
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !message.trim()) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/messages`,
        request("POST", {
          body: message,
        }),
      );
      setMessage("");
    });
  };

  const createHandoff = (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !taskId.trim() || !recipientActorId) return;
    const handoffId = handoffRequestId || `ho_${crypto.randomUUID()}`;
    if (!handoffRequestId) setHandoffRequestId(handoffId);
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/handoffs`,
        request("POST", {
          handoffId,
          taskId: taskId.trim(),
          recipientActorId,
          task: task.trim(),
          ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
          ...(parentHandoffId ? { parentHandoffId } : {}),
        }),
      );
      setTaskId("");
      setTask("");
      setRepoUrl("");
      setParentHandoffId("");
      setHandoffRequestId("");
    });
  };

  return (
    <section className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="max-w-6xl mx-auto p-4 sm:p-6 flex flex-col gap-4">
        <header>
          <h1 className="text-lg font-semibold">Collaboration rooms</h1>
          <p className="text-xs text-[var(--muted-foreground-2)] mt-1">
            Private task conversations with room members and configured employees. Employee work
            enters the existing human approval queue before any run starts.
          </p>
        </header>

        {error && (
          <p
            role="alert"
            className="rounded border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 p-3 text-sm"
          >
            {error}
            {retryableError && (
              <button
                type="button"
                className="ml-3 underline"
                onClick={() => void refresh(activeRoomId)}
              >
                Retry
              </button>
            )}
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4 min-h-[60vh]">
          <aside className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-3 flex flex-col gap-3">
            <form onSubmit={createRoom} className="flex flex-col gap-2">
              <input
                aria-label="New room title"
                value={roomTitle}
                onChange={(event) => setRoomTitle(event.target.value)}
                placeholder="New room"
                maxLength={120}
                className="min-w-0 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-sm"
              />
              <div className="flex gap-2">
                <select
                  aria-label="Room visibility"
                  value={roomVisibility}
                  onChange={(event) =>
                    setRoomVisibility(event.target.value as "private" | "shared")
                  }
                  className="min-w-0 flex-1 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                >
                  <option value="private">Private</option>
                  <option value="shared">Shared (membership required)</option>
                </select>
                <button
                  type="submit"
                  disabled={busy || !roomTitle.trim()}
                  className="rounded bg-[var(--primary)] px-3 py-2 text-xs font-semibold text-[var(--primary-text)] disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </form>
            <ul aria-label="Rooms" className="flex flex-col gap-1">
              {rooms.map((room) => (
                <li key={room.roomId}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveRoomId(room.roomId);
                    }}
                    className={`w-full rounded px-3 py-2 text-left text-sm ${room.roomId === activeRoomId ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]"}`}
                  >
                    <span className="block truncate font-medium">{room.title}</span>
                    <span className="block text-[10px] text-[var(--muted-foreground-2)]">
                      {room.visibility} · {room.memberCount ?? 0} members
                    </span>
                  </button>
                </li>
              ))}
              {rooms.length === 0 && (
                <li className="px-2 py-4 text-xs text-[var(--muted-foreground-2)]">
                  Create a room to start a conversation.
                </li>
              )}
            </ul>
          </aside>

          <main className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] flex min-h-0 flex-col">
            {detail ? (
              <>
                <div className="border-b border-[var(--border-1)] px-4 py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">{detail.room.title}</h2>
                    <p className="text-[10px] text-[var(--muted-foreground-2)]">
                      {members.length} active members
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_280px] flex-1 min-h-0">
                  <div className="flex min-h-[300px] flex-col border-b border-[var(--border-1)] xl:border-b-0 xl:border-r">
                    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
                      {detail.messages.map((item) => (
                        <article
                          key={item.messageId}
                          className="rounded-lg border border-[var(--border-1)] bg-[var(--panel)] p-3"
                        >
                          <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--muted-foreground-2)]">
                            <span className="font-semibold text-[var(--fg)]">
                              {item.senderKind === "agent"
                                ? (members.find((member) => member.actorId === item.senderActorId)
                                    ?.displayName ?? "Employee")
                                : item.senderUserId}
                            </span>
                            <time>{new Date(item.createdAt).toLocaleString()}</time>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
                          {item.sourceRunId && (
                            <div className="mt-2 border-t border-[var(--border-1)] pt-2 text-[10px]">
                              <p>Completed run: {item.sourceRunId}</p>
                              {item.sourceArtifactRefs?.map((artifact) => (
                                <a
                                  key={`${item.messageId}-${artifact.index}`}
                                  href={`/api/runs/${encodeURIComponent(item.sourceRunId ?? "")}/deliverables/${artifact.index}`}
                                  className="mr-2 underline"
                                >
                                  {artifact.path}
                                </a>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                      {detail.messages.length === 0 && (
                        <p className="m-auto text-sm text-[var(--muted-foreground-2)]">
                          No messages yet.
                        </p>
                      )}
                    </div>
                    <form
                      onSubmit={sendMessage}
                      className="border-t border-[var(--border-1)] p-3 flex gap-2"
                    >
                      <textarea
                        aria-label="Message"
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        maxLength={5000}
                        rows={2}
                        placeholder="Write a message…"
                        className="min-w-0 flex-1 resize-y rounded border border-[var(--border-1)] bg-[var(--panel)] px-3 py-2 text-sm"
                      />
                      <button
                        type="submit"
                        disabled={busy || !message.trim()}
                        className="self-end rounded bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-text)] disabled:opacity-50"
                      >
                        Send
                      </button>
                    </form>
                  </div>

                  <aside className="p-3 flex flex-col gap-4">
                    <section>
                      <h3 className="mb-2 text-xs font-semibold">Members</h3>
                      <ul className="flex flex-col gap-1 text-xs">
                        {members.map((member) => (
                          <li
                            key={member.actorId}
                            className="flex items-center justify-between gap-2 rounded bg-[var(--panel)] px-2 py-1.5"
                          >
                            <span className="truncate">
                              {member.displayName}{" "}
                              <span className="text-[var(--muted-foreground-2)]">
                                · {member.role}
                              </span>
                            </span>
                            {canManageMembers && member.role !== "owner" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void mutate(() =>
                                    api(
                                      `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/members/${encodeURIComponent(member.actorId)}`,
                                      { method: "DELETE" },
                                    ),
                                  )
                                }
                                className="text-[var(--destructive)]"
                              >
                                Remove
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {canManageMembers && (
                        <form onSubmit={inviteMember} className="mt-2 flex gap-2">
                          <input
                            aria-label="Member user ID or email"
                            value={inviteUserId}
                            onChange={(event) => setInviteUserId(event.target.value)}
                            placeholder="User ID or email"
                            className="min-w-0 flex-1 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                          />
                          <button
                            type="submit"
                            disabled={busy || !inviteUserId.trim()}
                            className="rounded border border-[var(--border-1)] px-2 py-2 text-xs disabled:opacity-50"
                          >
                            Invite
                          </button>
                        </form>
                      )}
                      {canManageMembers && (
                        <div className="mt-2 flex gap-2">
                          <select
                            aria-label="Employee profile"
                            value={selectedProfileId}
                            onChange={(event) => setSelectedProfileId(event.target.value)}
                            className="min-w-0 flex-1 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                          >
                            <option value="">Select employee</option>
                            {profiles.map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.config.emoji ? `${profile.config.emoji} ` : ""}
                                {profile.config.name} · v{profile.version}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={busy || !selectedProfileId}
                            onClick={addAgent}
                            className="rounded border border-[var(--border-1)] px-2 py-2 text-xs disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                      )}
                    </section>

                    <section className="border-t border-[var(--border-1)] pt-3">
                      <h3 className="mb-2 text-xs font-semibold">Handoffs</h3>
                      <form onSubmit={createHandoff} className="flex flex-col gap-2">
                        <input
                          aria-label="Task ID"
                          value={taskId}
                          onChange={(event) => { setTaskId(event.target.value); setHandoffRequestId(""); }}
                          maxLength={120}
                          placeholder="Task ID / grouping key"
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        />
                        <textarea
                          aria-label="Employee task request"
                          value={task}
                          onChange={(event) => { setTask(event.target.value); setHandoffRequestId(""); }}
                          maxLength={4000}
                          rows={3}
                          placeholder="Describe the work to request"
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        />
                        <input
                          aria-label="Repository URL"
                          value={repoUrl}
                          onChange={(event) => { setRepoUrl(event.target.value); setHandoffRequestId(""); }}
                          maxLength={500}
                          placeholder="Repository URL (uses employee default when blank)"
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        />
                        <select
                          aria-label="Parent handoff"
                          value={parentHandoffId}
                          onChange={(event) => { setParentHandoffId(event.target.value); setHandoffRequestId(""); }}
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        >
                          <option value="">New task handoff</option>
                          {parentHandoffs.map((handoff) => (
                            <option key={handoff.handoffId} value={handoff.handoffId}>
                              Continue {handoff.handoffId.slice(-8)} · depth {handoff.depth}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Handoff recipient"
                          value={recipientActorId}
                          onChange={(event) => { setRecipientActorId(event.target.value); setHandoffRequestId(""); }}
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        >
                          <option value="">Select recipient</option>
                          {recipients.map((member) => (
                            <option key={member.actorId} value={member.actorId}>
                              {member.actorKind === "agent" ? member.displayName : member.userId} ·{" "}
                              {member.role}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          disabled={busy || !taskId.trim() || !recipientActorId || !task.trim()}
                          className="rounded border border-[var(--border-1)] px-2 py-2 text-xs disabled:opacity-50"
                        >
                          Request / create handoff
                        </button>
                      </form>
                      <ul className="mt-3 flex flex-col gap-2">
                        {detail.handoffs.map((handoff) => (
                          <li
                            key={handoff.handoffId}
                            className="rounded bg-[var(--panel)] p-2 text-[10px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <strong className="truncate">{handoff.taskId}</strong>
                              <span>{handoff.status}</span>
                            </div>
                            <p className="mt-1 text-[var(--muted-foreground-2)]">
                              Depth {handoff.depth} · {handoff.remainingBudget} handoffs left
                            </p>
                            {handoff.approvalId && (
                              <div className="mt-1 border-t border-[var(--border-1)] pt-1">
                                <p>Approval: {handoff.execution?.approvalStatus ?? "pending"}</p>
                                {handoff.execution?.runStatus && (
                                  <p>Run: {handoff.execution.runStatus}</p>
                                )}
                                {handoff.execution?.error && (
                                  <p className="text-[var(--destructive)]">
                                    {handoff.execution.error}
                                  </p>
                                )}
                                {handoff.execution?.summary && (
                                  <p className="whitespace-pre-wrap">{handoff.execution.summary}</p>
                                )}
                                {handoff.execution?.pullUrl && (
                                  <a
                                    href={handoff.execution.pullUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                  >
                                    View pull request
                                  </a>
                                )}
                                {handoff.execution?.unavailable && (
                                  <p>Run status is temporarily unavailable.</p>
                                )}
                              </div>
                            )}
                            {handoff.status === "active" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void mutate(() =>
                                    api(
                                      `/api/collaboration/handoffs/${encodeURIComponent(handoff.handoffId)}/cancel`,
                                      request("POST", {}),
                                    ),
                                  )
                                }
                                className="mt-1 text-[var(--destructive)]"
                              >
                                Cancel handoff
                              </button>
                            )}
                          </li>
                        ))}
                        {detail.handoffs.length === 0 && (
                          <li className="text-[10px] text-[var(--muted-foreground-2)]">
                            No handoffs yet.
                          </li>
                        )}
                      </ul>
                    </section>
                  </aside>
                </div>
              </>
            ) : (
              <div className="m-auto p-8 text-center text-sm text-[var(--muted-foreground-2)]">
                Choose or create a room.
              </div>
            )}
          </main>
        </div>
      </div>
    </section>
  );
}
