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
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
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
  const [recipientActorId, setRecipientActorId] = useState("");
  const [parentHandoffId, setParentHandoffId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
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

  const members = useMemo(() => detail?.members ?? [], [detail]);
  const effectiveActorId = members.find(
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      try {
        const result = await api<{ room: Room }>(
          "/api/collaboration/rooms",
          request("POST", { title: roomTitle, visibility: roomVisibility }),
        );
        setRoomTitle("");
        await refresh(result.room.roomId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
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
    if (!activeRoomId) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/agents`,
        request("POST", { label: "Shiba agent" }),
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
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/handoffs`,
        request("POST", {
          handoffId: `ho_${crypto.randomUUID()}`,
          taskId: taskId.trim(),
          recipientActorId,
          ...(parentHandoffId ? { parentHandoffId } : {}),
        }),
      );
      setTaskId("");
      setParentHandoffId("");
    });
  };

  return (
    <section className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="max-w-6xl mx-auto p-4 sm:p-6 flex flex-col gap-4">
        <header>
          <h1 className="text-lg font-semibold">Collaboration rooms</h1>
          <p className="text-xs text-[var(--muted-foreground-2)] mt-1">
            Private task conversations with room members and agent participants. Handoffs are
            recorded with bounded lineage and budget.
          </p>
        </header>

        {error && (
          <p
            role="alert"
            className="rounded border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 p-3 text-sm"
          >
            {error}
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
                              {item.senderKind === "agent" ? "Agent" : item.senderUserId}
                            </span>
                            <time>{new Date(item.createdAt).toLocaleString()}</time>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
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
                        <button
                          type="button"
                          disabled={busy}
                          onClick={addAgent}
                          className="mt-2 w-full rounded border border-[var(--border-1)] px-2 py-2 text-xs disabled:opacity-50"
                        >
                          Add agent participant
                        </button>
                      )}
                    </section>

                    <section className="border-t border-[var(--border-1)] pt-3">
                      <h3 className="mb-2 text-xs font-semibold">Handoffs</h3>
                      <form onSubmit={createHandoff} className="flex flex-col gap-2">
                        <input
                          aria-label="Task ID"
                          value={taskId}
                          onChange={(event) => setTaskId(event.target.value)}
                          maxLength={120}
                          placeholder="Task ID"
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        />
                        <select
                          aria-label="Parent handoff"
                          value={parentHandoffId}
                          onChange={(event) => setParentHandoffId(event.target.value)}
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
                          onChange={(event) => setRecipientActorId(event.target.value)}
                          className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs"
                        >
                          <option value="">Select recipient</option>
                          {recipients.map((member) => (
                            <option key={member.actorId} value={member.actorId}>
                              {member.actorKind === "agent" ? "Agent" : member.userId} ·{" "}
                              {member.role}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          disabled={busy || !taskId.trim() || !recipientActorId}
                          className="rounded border border-[var(--border-1)] px-2 py-2 text-xs disabled:opacity-50"
                        >
                          Create handoff
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
