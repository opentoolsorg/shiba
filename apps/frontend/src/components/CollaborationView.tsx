import { toast } from "sonner";
import { optimisticMutation } from "../state/optimistic";
import { useWorkspaceEvents } from "../state/workspace-events";
import { roomLinkUrl } from "../room-links";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MAX_HANDOFF_DEPTH, type CollabRoomKind, type CollaborationHandoffBudgetState, type TeamWorkspaceDetail, type TeamWorkspaceMembership } from "@shiba/shared";
import { useCollaborationRoomRealtime } from "../collaboration-room-realtime";
import { NotificationsPanel } from "./notifications/NotificationsPanel";
import { resolveHandoffStatus, type HandoffCardStatus } from "./collab/HandoffCard";
import { MessageCards } from "./collab/MessageCards";
import { MessageList } from "./collab/MessageList";
import { MessageRow } from "./collab/MessageRow";
import { OwnerChip } from "./collab/OwnerChip";
import { PresenceChip, type PresenceState } from "./collab/PresenceChip";
import { PresenceStack, typingSummary } from "./collab/PresenceStack";
import { MentionMenu, useMentionAutocomplete } from "./collab/MentionAutocomplete";
import { RoomRail } from "./collab/RoomRail";
import { ThreadPane } from "./collab/ThreadPane";
import { PersonalExecutionSetup } from "./PersonalExecutionSetup";
import { TeamModelSessions } from "./TeamModelSessions";
import { SharedComputerSessions } from "./SharedComputerSessions";
import { BootstrapVerificationPanel } from "./BootstrapVerificationPanel";
import { DeliverablePreview } from "./DeliverablePreview";
import type { PersonalExecutionGrant } from "../personal-execution-client";

interface Room {
  roomId: string;
  title: string;
  visibility: "private" | "shared";
  memberCount?: number;
  kind?: CollabRoomKind;
  unreadCount?: number;
  lastMessageSeq?: number;
}

type RoomListTab = CollabRoomKind | "saved";

interface SavedMessageRef {
  roomId: string;
  messageId: string;
  savedAt: number;
}

async function loadRoomsForTab<T extends { rooms: Room[] }>(
  api: <R>(path: string, init?: RequestInit) => Promise<R>,
  tab: CollabRoomKind,
): Promise<Room[]> {
  try {
    const listed = await api<T>(`/api/collaboration/rooms?kind=${encodeURIComponent(tab)}`);
    if (Array.isArray(listed.rooms)) return listed.rooms;
  } catch {
    // Older deployments and test mocks may omit the kind query route.
  }
  const listed = await api<T>("/api/collaboration/rooms");
  return (listed.rooms ?? []).filter((room) => (room.kind ?? "room") === tab);
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
  threadRootId?: string | null;
  messageKind?: string;
  payloadJson?: string | null;
  sourceRunId?: string;
  sourceHandoffId?: string;
  sourceArtifactRefs?: Array<{
    index: number;
    path: string;
    bytes?: number;
    artifactId?: string;
    version?: number;
    sha256?: string;
  }>;
  sourceSlackEventId?: string;
  sourceSlackTeamId?: string;
  sourceSlackChannelId?: string;
  sourceSlackThreadTs?: string;
  sourceSlackUserId?: string;
}

interface SlackSource {
  teamId: string;
  channelId: string;
  threadTs: string;
  lastSeenAt: number;
  lastUserId: string;
  mappedRoomId?: string;
}

interface SlackLink {
  linkId: string;
  roomId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  status: "active" | "revoked";
  outboundConfigured?: boolean;
}

interface SlackDeliveryIntent {
  intentId: string;
  messageId: string;
  channelId: string;
  threadTs: string;
  content: string;
  status: "pending" | "blocked";
  deliveryStatus:
    | "awaiting_approval"
    | "approved"
    | "sending"
    | "sent"
    | "blocked"
    | "failed"
    | "unknown";
  approvedByUserId?: string | null;
  receiptTs?: string | null;
  outcomeDetail?: string | null;
}

interface Handoff extends CollaborationHandoffBudgetState {
  handoffId: string;
  taskId: string;
  senderActorId: string;
  senderUserId: string;
  recipientActorId: string;
  parentHandoffId: string | null;
  depth: number;
  status: "active" | "cancelled";
  grantedCapabilities: string[];
  createdAt: number;
  approvalId?: string;
  runId?: string;
  humanRequest?: { instructions: string; task: string; digest: string; requestedByUserId: string; messageCount: number; noteCount: number };
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

interface CollaborationMemoryNote {
  id: string;
  version: 1;
  sha256: string;
  title: string;
  content: string;
  createdByUserId: string;
  createdAt: number;
  revokedAt: number | null;
}

interface RoomDetail {
  room: Room;
  currentUserId: string;
  members: Member[];
  messages: Message[];
  handoffs: Handoff[];
  slackLinks?: SlackLink[];
  slackSources?: SlackSource[];
  slackDeliveryIntents?: SlackDeliveryIntent[];
  canApproveSlackOutbox?: boolean;
  slackOutboxEnabled?: boolean;
  memory?: CollaborationMemoryNote[];
}

interface PairedComputer {
  machineId: string;
  hostname: string;
  status: string;
}

async function collaborationApi<T>(path: string, init?: RequestInit): Promise<T> {
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

function hasApprovedRoomRun(handoff: Handoff): boolean {
  return Boolean(handoff.runId && handoff.execution?.approvalStatus === "approved" &&
    handoff.execution.runStatus && handoff.execution.runStatus !== "unknown" &&
    !handoff.execution.unavailable);
}

function request(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

function messagePayload(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function messageHandoffId(raw: string | null | undefined): string | undefined {
  const value = messagePayload(raw).handoffId;
  return typeof value === "string" ? value : undefined;
}

function cardThreadId(item: Message, detail: RoomDetail): string | undefined {
  const payload = messagePayload(item.payloadJson);
  const childId = payload.childThreadRootId;
  if (typeof childId === "string" && detail.messages.some((message) =>
    message.messageId === childId || message.threadRootId === childId)) return childId;
  const result = detail.messages.find((message) => message.messageId === payload.resultMessageId);
  return result?.threadRootId || item.threadRootId || undefined;
}

function handoffCardStatus(item: Message, detail: RoomDetail): HandoffCardStatus {
  const handoffId = messageHandoffId(item.payloadJson);
  const handoff = handoffId ? detail.handoffs.find((row) => row.handoffId === handoffId) : undefined;
  const reported = Boolean(handoffId && detail.messages.some((message) =>
    message.messageKind === "handoff_report" && messageHandoffId(message.payloadJson) === handoffId));
  return resolveHandoffStatus({
    handoffStatus: handoff?.status,
    reported,
    runStarted: Boolean(handoff && hasApprovedRoomRun(handoff)),
  });
}

export type CollaborationExecutionHandoff = Handoff & { roomId: string };
export type IncomingTaskDraft = { id: string; workspaceId: string; actorId: string; text: string; source?: "slack" | "team-onboarding"; draftTaskId?: string; draftTaskVersion?: number; progressRevision?: number; expiresAt?: number };

export interface CollaborationViewProps {
  workspaceId?: string;
  initialRoomId?: string;
  initialHandoffId?: string;
  initialEmployeeId?: string;
  onRoomChange?: (roomId: string) => void;
  onOpenNotificationPreferences?: () => void;
  incomingTaskDraft?: IncomingTaskDraft | null;
  incomingMention?: { id: string; roomId: string; agentId: string };
  onMentionConsumed?: (id: string) => void;
  onTaskDraftConsumed?: (id: string) => void;
  renderExecution?: (handoff: CollaborationExecutionHandoff) => ReactNode;
  renderApproval?: (handoff: CollaborationExecutionHandoff) => ReactNode;
}

type DetailTab = "members" | "context" | "work" | "slack" | "execution";
const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "members", label: "People" },
  { id: "context", label: "Context" },
  { id: "work", label: "Work" },
  { id: "slack", label: "Slack" },
  { id: "execution", label: "Execution" },
];

interface ArtifactReviewState {
  status: string;
  revision: number;
  note?: string;
}

function isArtifactReviewState(review: unknown): review is ArtifactReviewState {
  return !!review && typeof review === "object" &&
    "status" in review && typeof review.status === "string" &&
    "revision" in review && typeof review.revision === "number" &&
    Number.isSafeInteger(review.revision) && review.revision >= 0 &&
    (!("note" in review) || typeof review.note === "string");
}

function ArtifactReviewControls({ artifactUrl, workspaceId }: { artifactUrl: string; workspaceId?: string }) {
  const reviewUrl = `${artifactUrl}/review`;
  const [review, setReview] = useState<ArtifactReviewState | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(true);
  const [reviewCurrent, setReviewCurrent] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(reviewUrl, {
      credentials: "same-origin",
      headers: workspaceId ? { "X-Shiba-Workspace": workspaceId } : undefined,
      signal,
    });
    if (!res.ok) throw new Error("Could not load the latest review.");
    const data = (await res.json()) as { review?: ArtifactReviewState } | null;
    if (!isArtifactReviewState(data?.review)) throw new Error("Could not load the latest review.");
    return data.review;
  }, [reviewUrl, workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((latest) => {
      if (controller.signal.aborted) return;
      setReview(latest);
      setReviewCurrent(true);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Could not load the latest review.");
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [load]);
  const refresh = async (message = "") => {
    setReviewCurrent(false);
    setError(message);
    try {
      const latest = await load();
      if (review && latest.revision < review.revision) throw new Error("Review revision moved backwards.");
      setReview(latest);
      setReviewCurrent(true);
    } catch {
      setError(message ? `${message} Could not refresh the latest review.` : "Could not refresh the latest review.");
    }
  };
  const decide = async (status: "approved" | "changes_requested") => {
    if (busy || !reviewCurrent || !review) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(reviewUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(workspaceId ? { "X-Shiba-Workspace": workspaceId } : {}) },
        body: JSON.stringify({
          status,
          expectedRevision: review.revision,
          ...(status === "changes_requested" ? { note } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        deliverable?: { review?: ArtifactReviewState };
      } | null;
      if (!res.ok) {
        await refresh(data?.error ?? "Review could not be saved.");
        return;
      }
      const saved = data?.deliverable?.review;
      if (!isArtifactReviewState(saved) || saved.revision <= review.revision) throw new Error("Missing saved review revision.");
      setReview(saved);
      if (status === "changes_requested") setNote("");
    } catch {
      await refresh("The review may have been saved. Check the latest review before trying again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {review && reviewCurrent && (
        <span>
          review: {review.status.replace(/_/g, " ")}
          {review.note ? ` — ${review.note}` : ""}
        </span>
      )}
      <button
        type="button"
        disabled={busy || !reviewCurrent}
        onClick={() => void decide("approved")}
        className="min-h-[44px] border border-[var(--line)] bg-[var(--card)] px-1 underline disabled:opacity-50"
      >
        Approve revision
      </button>
      <input
        aria-label="Requested change note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="change note"
        className="min-h-[44px] w-28 border border-[var(--line)] bg-[var(--card)] px-1"
      />
      <button
        type="button"
        disabled={busy || !reviewCurrent || !note.trim()}
        onClick={() => void decide("changes_requested")}
        className="min-h-[44px] border border-[var(--line)] bg-[var(--card)] px-1 underline disabled:opacity-50"
      >
        Request change
      </button>
      {!reviewCurrent && !busy && (
        <button
          type="button"
          className="min-h-[44px] border border-[var(--line)] bg-[var(--card)] px-1 underline"
          onClick={() => {
            setBusy(true);
            void refresh().finally(() => setBusy(false));
          }}
        >
          Refresh review
        </button>
      )}
      {error && <span role="status">{error}</span>}
    </span>
  );
}

function handoffElementId(workspaceId: string | undefined, roomId: string, handoffId: string): string {
  return `collaboration-handoff-${encodeURIComponent(workspaceId ?? "personal")}-${encodeURIComponent(roomId)}-${encodeURIComponent(handoffId)}`;
}

function messageElementId(workspaceId: string | undefined, roomId: string, messageId: string, reply = false): string {
  return `collaboration-${reply ? "reply" : "message"}-${encodeURIComponent(workspaceId ?? "personal")}-${encodeURIComponent(roomId)}-${encodeURIComponent(messageId)}`;
}

/** A workspace switch remounts all drafts, reads, and sockets before old content can paint. */
export function CollaborationView(props: CollaborationViewProps = {}): JSX.Element {
  const workspaceId = props.workspaceId?.startsWith("ws_") ? props.workspaceId : undefined;
  return (
    <ScopedCollaborationView key={workspaceId ?? "personal"} {...props} workspaceId={workspaceId} />
  );
}

function ScopedCollaborationView({
  workspaceId,
  initialRoomId,
  initialHandoffId,
  initialEmployeeId,
  onRoomChange,
  onOpenNotificationPreferences,
  incomingTaskDraft,
  incomingMention,
  onMentionConsumed,
  onTaskDraftConsumed,
  renderExecution,
  renderApproval,
}: CollaborationViewProps): JSX.Element {
  const api = useCallback(
    <T,>(path: string, init?: RequestInit) =>
      collaborationApi<T>(path, {
        ...init,
        headers: { ...init?.headers, ...(workspaceId ? { "X-Shiba-Workspace": workspaceId } : {}) },
      }),
    [workspaceId],
  );
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomListTab, setRoomListTab] = useState<RoomListTab>("room");
  const [tabUnread, setTabUnread] = useState<Record<CollabRoomKind, number>>({
    channel: 0,
    dm: 0,
    room: 0,
  });
  const [savedItems, setSavedItems] = useState<SavedMessageRef[]>([]);
  const [activeRoomId, setActiveRoomId] = useState(initialRoomId ?? "");
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [messageSource, setMessageSource] = useState<{ roomId: string; messageId: string } | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Array<Message & { roomId: string }>>([]);
  const roomPatches = useRef(new Map<string, Room>());
  const messagePatches = useRef(new Map<string, Map<string, Message>>());
  const mergeRoomList = useCallback((loaded: Room[], current: Room[]) => {
    const rows = new Map(loaded.map((room) => [room.roomId, room]));
    for (const room of roomPatches.current.values()) {
      if ((room.kind ?? "room") === roomListTab) rows.set(room.roomId, { ...rows.get(room.roomId), ...room });
    }
    for (const room of current) if (room.roomId.startsWith("pending_")) rows.set(room.roomId, room);
    return [...rows.values()];
  }, [roomListTab]);
  const mergeRoomDetail = useCallback((loaded: RoomDetail) => {
    if (!messagePatches.current.has(loaded.room.roomId)) return loaded;
    const messages = new Map(loaded.messages.map((message) => [message.messageId, message]));
    for (const message of messagePatches.current.get(loaded.room.roomId)?.values() ?? []) messages.set(message.messageId, message);
    return { ...loaded, messages: [...messages.values()] };
  }, []);
  const [presence, setPresence] = useState<Array<{ actorId: string; label: string; state: PresenceState }>>([]);
  const [roomOwner, setRoomOwner] = useState("");
  const [openThreadId, setOpenThreadId] = useState("");
  const [roomTitle, setRoomTitle] = useState("");
  const [roomVisibility, setRoomVisibility] = useState<"private" | "shared">("private");
  const [inviteUserId, setInviteUserId] = useState("");
  const [messageDrafts, setMessageDrafts] = useState(() => new Map<string, string>());
  const message = messageDrafts.get(openThreadId) ?? "";
  const updateMessageDraft = useCallback((threadId: string, update: (current: string) => string) => {
    setMessageDrafts((drafts) => {
      const current = drafts.get(threadId) ?? "";
      const value = update(current);
      if (value === current) return drafts;
      const next = new Map(drafts);
      if (value) next.set(threadId, value);
      else next.delete(threadId);
      return next;
    });
  }, []);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const insertedMention = useRef<string | null>(null);
  useEffect(() => {
    if (!incomingMention || insertedMention.current === incomingMention.id ||
      incomingMention.roomId !== activeRoomId || detail?.room.roomId !== activeRoomId) return;
    insertedMention.current = incomingMention.id;
    updateMessageDraft(openThreadId, (current) => `${current}${current && !/\s$/.test(current) ? " " : ""}@agent:${incomingMention.agentId} `);
    messageInput.current?.focus();
    onMentionConsumed?.(incomingMention.id);
  }, [incomingMention, activeRoomId, detail, onMentionConsumed, openThreadId, updateMessageDraft]);
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState("");
  const [draftReplacement, setDraftReplacement] = useState<{ id: string; roomId: string; previousTask: string; text: string; provenance: string } | null>(null);
  const [draftExpiryTick, setDraftExpiryTick] = useState(0);
  const surfacedTeamDrafts = useRef(new Set<string>());
  const [repoUrl, setRepoUrl] = useState("");
  const [workDestination, setWorkDestination] = useState<"repository" | "artifact-workspace">(
    "repository",
  );
  const [deliverablePath, setDeliverablePath] = useState("reports/employee-summary.md");
  const [recipientActorId, setRecipientActorId] = useState("");
  const [parentHandoffId, setParentHandoffId] = useState("");
  const [profiles, setProfiles] = useState<EmployeeProfile[]>([]);
  const [computers, setComputers] = useState<PairedComputer[]>([]);
  const [workspaceRoster, setWorkspaceRoster] = useState<TeamWorkspaceMembership[] | null>(null);
  const [workspaceRosterUnavailable, setWorkspaceRosterUnavailable] = useState(false);
  const [executionTarget, setExecutionTarget] = useState("sandbox");
  const [personalExecutionMode, setPersonalExecutionMode] = useState(false);
  const [showTeamModels, setShowTeamModels] = useState(false);
  const [showSharedComputer, setShowSharedComputer] = useState(false);
  const [showBootstrapVerification, setShowBootstrapVerification] = useState(false);
  const [personalGrant, setPersonalGrant] = useState<PersonalExecutionGrant | null>(null);
  const personalGrantIntent = useRef("");
  const [selectedProfileId, setSelectedProfileId] = useState(initialEmployeeId ?? "");
  const [detailTab, setDetailTab] = useState<DetailTab>("members");
  const consumedHandoffIntent = useRef<string | null>(null);
  const [selectedSlackSource, setSelectedSlackSource] = useState("");
  const [handoffRequestId, setHandoffRequestId] = useState("");
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<string[]>([]);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryableError, setRetryableError] = useState(false);
  const [copyLinkStatus, setCopyLinkStatus] = useState("");
  const activeRoomRef = useRef(activeRoomId);
  const roomReadEpoch = useRef(0);
  const revokedRooms = useRef(new Set<string>());

  useEffect(() => {
    setDraftReplacement(null);
  }, [incomingTaskDraft?.id, incomingTaskDraft?.text, incomingTaskDraft?.actorId, incomingTaskDraft?.workspaceId, incomingTaskDraft?.source, incomingTaskDraft?.draftTaskId, incomingTaskDraft?.draftTaskVersion, incomingTaskDraft?.progressRevision, incomingTaskDraft?.expiresAt, activeRoomId, task]);
  useEffect(() => {
    if (incomingTaskDraft?.source !== "team-onboarding" || !Number.isFinite(incomingTaskDraft.expiresAt) || Number(incomingTaskDraft.expiresAt) <= Date.now()) return;
    const delay = Math.max(0, Math.min(2147483647, Number(incomingTaskDraft.expiresAt) - Date.now()));
    const timer = setTimeout(() => setDraftExpiryTick((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [incomingTaskDraft?.id, incomingTaskDraft?.source, incomingTaskDraft?.expiresAt, draftExpiryTick]);

  const clearRoomDrafts = useCallback(() => {
    setMessageDrafts(new Map());
    setOpenThreadId("");
    setCopyLinkStatus("");
    setTask("");
    setDraftReplacement(null);
    setTaskId("");
    setRepoUrl("");
    setWorkDestination("repository");
    setDeliverablePath("reports/employee-summary.md");
    setParentHandoffId("");
    setRecipientActorId("");
    setPersonalExecutionMode(false);
    setShowTeamModels(false);
    setShowSharedComputer(false);
    setShowBootstrapVerification(false);
    setPersonalGrant(null);
    personalGrantIntent.current = "";
    setHandoffRequestId("");
    setMemoryTitle("");
    setMemoryContent("");
    setSelectedMemoryIds([]);
    setSelectedMessageIds([]);
    setInviteUserId("");
    setSelectedSlackSource("");
  }, []);

  const isCurrentRoomRead = useCallback(
    (epoch: number, roomId: string) =>
      roomReadEpoch.current === epoch &&
      activeRoomRef.current === roomId &&
      !revokedRooms.current.has(roomId),
    [],
  );

  const loseRoomAccess = useCallback(
    (roomId: string) => {
      if (activeRoomRef.current !== roomId) return;
      roomReadEpoch.current++;
      if (roomId) revokedRooms.current.add(roomId);
      roomPatches.current.delete(roomId);
      messagePatches.current.delete(roomId);
      setPendingMessages((current) => current.filter((message) => message.roomId !== roomId));
      activeRoomRef.current = "";
      clearRoomDrafts();
      setMessageSource(null);
      setDetail(null);
      setActiveRoomId("");
      setRooms((current) => current.filter((room) => room.roomId !== roomId));
      setError("Access to this room ended. Its contents are no longer available in this session.");
      setRetryableError(false);
    },
    [clearRoomDrafts],
  );

  const realtime = useCollaborationRoomRealtime({
    roomId: activeRoomId,
    workspaceId,
    enabled: Boolean(activeRoomId),
    typingText: message,
    onAccessLost: loseRoomAccess,
    onRefresh: (roomId) => {
      if (activeRoomRef.current !== roomId || revokedRooms.current.has(roomId)) return;
      const epoch = ++roomReadEpoch.current;
      void api<RoomDetail>(`/api/collaboration/rooms/${encodeURIComponent(roomId)}`)
        .then((loaded) => {
          if (isCurrentRoomRead(epoch, roomId)) setDetail(mergeRoomDetail(loaded));
        })
        .catch((cause) => {
          if (!isCurrentRoomRead(epoch, roomId)) return;
          if (isMembershipLost(cause)) loseRoomAccess(roomId);
          else {
            setError(cause instanceof Error ? cause.message : String(cause));
            setRetryableError(true);
          }
        });
    },
  });

  const presenceScope = JSON.stringify([workspaceId ?? "default", activeRoomId]);
  const [memberLastSeen, setMemberLastSeen] = useState<{ scope: string; seen: Record<string, number> }>({ scope: "", seen: {} });
  useEffect(() => {
    setMemberLastSeen((current) => {
      const seen = current.scope === presenceScope ? { ...current.seen } : {};
      let changed = current.scope !== presenceScope;
      for (const viewer of realtime.viewers) {
        if (viewer.lastSeenAt > (seen[viewer.label] ?? 0)) {
          seen[viewer.label] = viewer.lastSeenAt;
          changed = true;
        }
      }
      return changed ? { scope: presenceScope, seen } : current;
    });
  }, [presenceScope, realtime.viewers]);

  useLayoutEffect(() => {
    clearRoomDrafts();
  }, [activeRoomId, clearRoomDrafts]);

  useEffect(() => {
    const available = new Set(
      (detail?.memory ?? []).filter((note) => note.revokedAt === null).map((note) => note.id),
    );
    if (selectedMemoryIds.some((id) => !available.has(id))) {
      setSelectedMemoryIds((current) => current.filter((id) => available.has(id)));
      setHandoffRequestId("");
      setError(
        "A selected shared note is no longer available. Review the shared context before requesting work.",
      );
    }
  }, [detail?.memory, selectedMemoryIds]);

  const refresh = useCallback(
    async (roomId = activeRoomRef.current) => {
      const epoch = ++roomReadEpoch.current;
      const previousRoomId = activeRoomRef.current;
      let selected = previousRoomId;
      try {
        if (roomListTab === "saved") {
          const saved = await api<{ saved: SavedMessageRef[] }>("/api/collaboration/saved");
          if (!isCurrentRoomRead(epoch, previousRoomId)) return;
          setSavedItems(saved.saved ?? []);
          return;
        }
        const loadedRooms = await loadRoomsForTab<{ rooms: Room[] }>(api, roomListTab);
        if (!isCurrentRoomRead(epoch, previousRoomId)) return;
        const availableRooms = loadedRooms.filter((room) => !revokedRooms.current.has(room.roomId));
        setRooms((current) => mergeRoomList(availableRooms, current));
        setTabUnread((current) => ({
          ...current,
          [roomListTab]: availableRooms.reduce((sum, room) => sum + (room.unreadCount ?? 0), 0),
        }));
        selected = roomId || (revokedRooms.current.size ? "" : availableRooms[0]?.roomId) || "";
        if (revokedRooms.current.has(selected)) return;
        activeRoomRef.current = selected;
        setActiveRoomId(selected);
        if (selected !== previousRoomId || !selected) setDetail(null);
        if (!selected) return;
        const loaded = await api<RoomDetail>(
          `/api/collaboration/rooms/${encodeURIComponent(selected)}`,
        );
        if (!isCurrentRoomRead(epoch, selected)) return;
        setDetail(mergeRoomDetail(loaded));
        setError("");
        setRetryableError(false);
      } catch (cause) {
        if (!isCurrentRoomRead(epoch, selected)) return;
        if (isMembershipLost(cause)) loseRoomAccess(selected);
        else {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRetryableError(true);
        }
      }
    },
    [api, isCurrentRoomRead, loseRoomAccess, roomListTab, mergeRoomList, mergeRoomDetail],
  );

  const workspaceLive = useWorkspaceEvents({
    workspaceId: workspaceId ?? null,
    enabled: Boolean(workspaceId),
    onReconnect: () => { roomPatches.current.clear(); messagePatches.current.clear(); void refresh(); },
    onEvent: (event) => {
      if (event.kind === "room.updated") {
        const room = event.payload?.room as Room | undefined;
        if (!room || room.roomId !== event.entityId || typeof room.title !== "string" ||
          !["private", "shared"].includes(room.visibility) || revokedRooms.current.has(room.roomId)) return;
        roomPatches.current.set(room.roomId, room);
        if ((room.kind ?? "room") === roomListTab) {
          setRooms((current) => [...current.filter((item) => item.roomId !== room.roomId), { ...current.find((item) => item.roomId === room.roomId), ...room }]);
        }
      } else if (event.kind === "message.created" && event.entityId === activeRoomRef.current) {
        const message = event.payload?.message as Message | undefined;
        if (!message || typeof message.messageId !== "string" || typeof message.body !== "string" ||
          message.senderKind !== "human" || typeof message.createdAt !== "number") return;
        const patches = messagePatches.current.get(event.entityId) ?? new Map<string, Message>();
        patches.set(message.messageId, message);
        messagePatches.current.set(event.entityId, patches);
        setDetail((current) => current?.room.roomId === event.entityId && !current.messages.some((item) => item.messageId === message.messageId)
          ? { ...current, messages: [...current.messages, message] } : current);
      } else if (event.kind === "collaboration.change" || event.kind === "room.message") {
        void refresh();
      }
    },
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const epoch = ++roomReadEpoch.current;
      // Read the live selection, like refresh does: a poll that started before
      // activeRoomId was set must not clear the room this surface is showing.
      let selected = activeRoomRef.current;
      try {
        if (roomListTab === "saved") {
          const saved = await api<{ saved: SavedMessageRef[] }>("/api/collaboration/saved");
          if (!cancelled) setSavedItems(saved.saved ?? []);
          return;
        }
        const loadedRooms = await loadRoomsForTab<{ rooms: Room[] }>(api, roomListTab);
        if (cancelled || !isCurrentRoomRead(epoch, activeRoomRef.current)) return;
        const availableRooms = loadedRooms.filter((room) => !revokedRooms.current.has(room.roomId));
        setRooms((current) => mergeRoomList(availableRooms, current));
        setTabUnread((current) => ({
          ...current,
          [roomListTab]: availableRooms.reduce((sum, room) => sum + (room.unreadCount ?? 0), 0),
        }));
        selected = activeRoomRef.current || (revokedRooms.current.size ? "" : availableRooms[0]?.roomId) || "";
        if (revokedRooms.current.has(selected)) return;
        activeRoomRef.current = selected;
        setActiveRoomId(selected);
        if (selected) {
          const loaded = await api<RoomDetail>(
            `/api/collaboration/rooms/${encodeURIComponent(selected)}`,
          );
          if (cancelled || !isCurrentRoomRead(epoch, selected)) return;
          setDetail(mergeRoomDetail(loaded));
          setError("");
          setRetryableError(false);
        } else if (!cancelled && isCurrentRoomRead(epoch, "")) setDetail(null);
      } catch (cause) {
        if (cancelled || !isCurrentRoomRead(epoch, selected)) return;
        if (isMembershipLost(cause)) {
          loseRoomAccess(selected);
        } else if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRetryableError(true);
        }
      }
    };
    void load();
    const live = workspaceLive;
    const timer = live
      ? undefined
      : window.setInterval(() => {
          void load();
        }, 5_000);
    return () => {
      cancelled = true;
      roomReadEpoch.current++;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [activeRoomId, api, isCurrentRoomRead, loseRoomAccess, roomListTab, workspaceId, workspaceLive, mergeRoomList, mergeRoomDetail]);

  useEffect(() => {
    if (!activeRoomId) return;
    let cancelled = false;
    const loadPresence = () => {
      void api<{ presence?: Array<{ actorId: string; label: string; state: PresenceState }> }>(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/presence`,
      )
        .then((body) => {
          if (!cancelled && Array.isArray(body.presence)) setPresence(body.presence);
        })
        .catch(() => {});
      void api<{ tasks?: Array<{ ownerActorId?: string; status?: string }> }>(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/tasks`,
      )
        .then((body) => {
          if (cancelled || !Array.isArray(body.tasks)) return;
          const open = body.tasks.find((task) => task.status !== "done" && task.ownerActorId);
          setRoomOwner(open?.ownerActorId ?? "");
        })
        .catch(() => {});
    };
    loadPresence();
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const kinds: CollabRoomKind[] = ["channel", "dm", "room"];
      const totals = { channel: 0, dm: 0, room: 0 };
      for (const kind of kinds) {
        try {
          const listed = await loadRoomsForTab<{ rooms: Room[] }>(api, kind);
          if (cancelled) return;
          totals[kind] = listed.reduce((sum, room) => sum + (room.unreadCount ?? 0), 0);
        } catch {
          // Unread totals are ancillary.
        }
      }
      if (!cancelled) setTabUnread(totals);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

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
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void api<{ computers?: PairedComputer[] }>("/api/computers")
      .then((result) => {
        if (!cancelled)
          setComputers(
            (result.computers ?? []).filter(
              (item) => typeof item.machineId === "string" && typeof item.hostname === "string",
            ),
          );
      })
      .catch(() => {
        if (!cancelled) setComputers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void api<{ workspace: TeamWorkspaceDetail }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    )
      .then((result) => {
        if (!cancelled) {
          setWorkspaceRoster(result.workspace.members);
          setWorkspaceRosterUnavailable(false);
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setWorkspaceRoster(null);
        setWorkspaceRosterUnavailable(true);
        if (isMembershipLost(cause)) loseRoomAccess(activeRoomRef.current);
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, loseRoomAccess]);

  useEffect(() => {
    if (
      !initialRoomId ||
      initialRoomId === activeRoomRef.current ||
      revokedRooms.current.has(initialRoomId)
    )
      return;
    roomReadEpoch.current++;
    activeRoomRef.current = initialRoomId;
    clearRoomDrafts();
    setMessageSource(null);
    setDetail(null);
    setActiveRoomId(initialRoomId);
  }, [initialRoomId, clearRoomDrafts]);

  const onRoomChangeRef = useRef(onRoomChange);
  useEffect(() => { onRoomChangeRef.current = onRoomChange; }, [onRoomChange]);
  useEffect(() => {
    if (activeRoomId && activeRoomRef.current === activeRoomId && detail?.room.roomId === activeRoomId) onRoomChangeRef.current?.(activeRoomId);
  }, [activeRoomId, detail?.room.roomId]);

  useEffect(() => {
    if (initialEmployeeId) setSelectedProfileId(initialEmployeeId);
  }, [initialEmployeeId]);

  useEffect(() => {
    if (!initialRoomId || !initialHandoffId) {
      consumedHandoffIntent.current = null;
      return;
    }
    const intent = JSON.stringify([initialRoomId, initialHandoffId]);
    if (consumedHandoffIntent.current === intent || activeRoomId !== initialRoomId ||
      activeRoomRef.current !== initialRoomId || revokedRooms.current.has(initialRoomId) ||
      detail?.room.roomId !== initialRoomId || !detail.handoffs.some((handoff) => handoff.handoffId === initialHandoffId)) return;
    if (detailTab !== "work") {
      setDetailTab("work");
      return;
    }
    const target = document.getElementById(handoffElementId(workspaceId, initialRoomId, initialHandoffId));
    if (!target) return;
    consumedHandoffIntent.current = intent;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest" });
  }, [initialRoomId, initialHandoffId, activeRoomId, detail, detailTab, workspaceId]);

  const linkedMessage = messageSource && detail?.room.roomId === messageSource.roomId
    ? detail.messages.find((item) => item.messageId === messageSource.messageId)
    : undefined;
  useEffect(() => {
    if (!messageSource || !linkedMessage || activeRoomId !== messageSource.roomId ||
      activeRoomRef.current !== messageSource.roomId || revokedRooms.current.has(messageSource.roomId)) return;
    const threadRootId = linkedMessage.threadRootId ?? "";
    if (openThreadId !== threadRootId) {
      setOpenThreadId(threadRootId);
      return;
    }
    const target = document.getElementById(messageElementId(workspaceId, messageSource.roomId, linkedMessage.messageId, Boolean(threadRootId)));
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest" });
    setMessageSource(null);
  }, [messageSource, linkedMessage, activeRoomId, openThreadId, workspaceId]);

  const members = useMemo(() => detail?.members ?? [], [detail]);
  const mentions = useMentionAutocomplete({
    members, selfUserId: detail?.currentUserId ?? "", value: message, input: messageInput,
    setValue: (value) => updateMessageDraft(openThreadId, () => value),
  });
  const workingEmployees = (detail?.handoffs ?? []).filter((handoff) => handoff.status === "active" && handoff.execution?.runStatus === "running")
    .map((handoff) => members.find((member) => member.actorId === handoff.recipientActorId)?.displayName ?? "Employee");
  const typing = typingSummary(realtime.viewers, realtime.viewerId, [...new Set(workingEmployees)]);
  const effectiveActorId =
    members.find(
      (member) => member.userId === detail?.currentUserId && member.actorKind === "human",
    )?.actorId || "";
  const reviewableSlackDraft = Boolean(incomingTaskDraft && (incomingTaskDraft.source !== "team-onboarding" || (Number.isSafeInteger(incomingTaskDraft.expiresAt) && Number(incomingTaskDraft.expiresAt) > Date.now())) && detail && workspaceId && incomingTaskDraft.workspaceId === workspaceId &&
    incomingTaskDraft.actorId === detail.currentUserId && activeRoomId && detail.room.roomId === activeRoomId &&
    activeRoomRef.current === activeRoomId && !revokedRooms.current.has(activeRoomId) &&
    members.some((member) => member.actorKind === "human" && member.userId === detail.currentUserId && member.status === "active"));
  const validSlackDraft = Boolean(incomingTaskDraft?.id && incomingTaskDraft.text.trim() && incomingTaskDraft.text.length <= 4000 && (incomingTaskDraft.source !== "team-onboarding" || (incomingTaskDraft.draftTaskId && Number.isSafeInteger(incomingTaskDraft.draftTaskVersion) && Number(incomingTaskDraft.draftTaskVersion) > 0 && Number.isSafeInteger(incomingTaskDraft.progressRevision) && Number(incomingTaskDraft.progressRevision) >= 0)));
  useEffect(() => {
    if (incomingTaskDraft?.source !== "team-onboarding" || !reviewableSlackDraft || !validSlackDraft || !detail || Number(incomingTaskDraft.expiresAt) <= Date.now()) return;
    const key = JSON.stringify([incomingTaskDraft.id, activeRoomId, detail.currentUserId]);
    if (surfacedTeamDrafts.current.has(key)) return;
    surfacedTeamDrafts.current.add(key);
    setDetailTab("work");
  }, [incomingTaskDraft?.id, incomingTaskDraft?.source, activeRoomId, detail, reviewableSlackDraft, validSlackDraft]);
  const draftProvenance = JSON.stringify([incomingTaskDraft?.source, incomingTaskDraft?.draftTaskId, incomingTaskDraft?.draftTaskVersion, incomingTaskDraft?.progressRevision, incomingTaskDraft?.expiresAt]);
  const replaceReviewed = Boolean(incomingTaskDraft && draftReplacement && draftReplacement.id === incomingTaskDraft.id && draftReplacement.provenance === draftProvenance &&
    draftReplacement.roomId === activeRoomId && draftReplacement.previousTask === task && draftReplacement.text === incomingTaskDraft.text);
  const useSlackDraft = () => {
    if (!incomingTaskDraft || !reviewableSlackDraft || !validSlackDraft || (incomingTaskDraft.source === "team-onboarding" && Number(incomingTaskDraft.expiresAt) <= Date.now()) || (task && !replaceReviewed)) return;
    setTask(incomingTaskDraft.text);
    setSelectedMessageIds([]);
    setSelectedMemoryIds([]);
    setHandoffRequestId("");
    setDraftReplacement(null);
    onTaskDraftConsumed?.(incomingTaskDraft.id);
  };
  const recipients = members.filter((member) => member.actorId !== effectiveActorId);
  // Mirrors the request body sent below: grantedCapabilities is never set, so the
  // backend applies this default — a parent can only be continued when its own
  // grants cover it and both its lineage and shared root budget allow another handoff.
  const requestedCapabilities = ["room.read", "message.send", "handoff.create", "task.cancel"];
  const parentHandoffs = (detail?.handoffs ?? []).filter(
    (handoff) =>
      handoff.status === "active" &&
      handoff.remainingBudget > 0 &&
      handoff.currentRootBudget > 0 &&
      handoff.depth < MAX_HANDOFF_DEPTH &&
      requestedCapabilities.every((capability) =>
        (handoff.grantedCapabilities ?? []).includes(capability),
      ) &&
      (handoff.recipientActorId === effectiveActorId ||
        handoff.senderUserId === detail?.currentUserId) &&
      handoff.taskId === taskId.trim(),
  );
  const parentUnavailable = !!parentHandoffId && !parentHandoffs.some((handoff) => handoff.handoffId === parentHandoffId);
  const canManageMembers = members.some(
    (member) => member.role === "owner" && member.userId === detail?.currentUserId,
  );

  const mutate = async (operation: () => Promise<unknown>) => {
    const operationRoomId = activeRoomId;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (activeRoomRef.current === operationRoomId) await refresh(operationRoomId);
    } catch (cause) {
      if (activeRoomRef.current !== operationRoomId) return;
      if (isMembershipLost(cause)) {
        loseRoomAccess(operationRoomId);
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
    if (!roomTitle.trim() || busy) return;
    const pending: Room = { roomId: `pending_${crypto.randomUUID()}`, title: roomTitle.trim(), visibility: roomVisibility, kind: "room" };
    setBusy(true);
    setError("");
    void optimisticMutation({
      apply: () => { setRooms((current) => [...current, pending]); setRoomTitle(""); },
      commit: () => api<{ room: Room }>("/api/collaboration/rooms", request("POST", {
        title: pending.title, visibility: pending.visibility,
      })),
      reconcile: (result) => {
        setRooms((current) => [...current.filter((room) => room.roomId !== pending.roomId && room.roomId !== result.room.roomId), result.room]);
        void refresh(result.room.roomId);
      },
      rollback: () => {
        setRooms((current) => current.filter((room) => room.roomId !== pending.roomId));
        setRoomTitle((current) => current || pending.title);
      },
      onError: (cause) => {
        const text = cause instanceof Error ? cause.message : String(cause);
        setError(text); toast.error(text);
      },
    }).finally(() => setBusy(false));
  };

  const startDirectMessage = async (userId: string) => {
    const sourceRoomId = activeRoomRef.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ dm: Room }>("/api/collaboration/dms", request("POST", { userId }));
      if (activeRoomRef.current !== sourceRoomId) return;
      if (result.dm.roomId === sourceRoomId && roomListTab === "dm") {
        await refresh(sourceRoomId);
        return;
      }
      roomReadEpoch.current++;
      activeRoomRef.current = result.dm.roomId;
      setDetail(null);
      setRoomListTab("dm");
      setActiveRoomId(result.dm.roomId);
    } catch (cause) {
      if (activeRoomRef.current === sourceRoomId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const inviteMember = (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !inviteUserId.trim()) return;
    if (workspaceId && !workspaceRoster?.some((member) => member.userId === inviteUserId)) {
      setError("Choose a current workspace member before adding them to this group chat.");
      return;
    }
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

  const linkSlackSource = () => {
    if (!activeRoomId || !selectedSlackSource) return;
    const [teamId, channelId, threadTs] = selectedSlackSource.split("|");
    if (!teamId || !channelId || !threadTs) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/slack-links`,
        request("POST", { teamId, channelId, threadTs }),
      );
      setSelectedSlackSource("");
    });
  };

  const queueSlackDeliveryIntent = (messageId: string, linkId: string) => {
    if (!activeRoomId) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/messages/${encodeURIComponent(messageId)}/slack-delivery`,
        request("POST", { linkId }),
      );
    });
  };

  const approveSlackDeliveryIntent = (intentId: string) => {
    if (!activeRoomId) return;
    void mutate(() =>
      api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/slack-delivery/${encodeURIComponent(intentId)}/approve`,
        request("POST", {}),
      ),
    );
  };

  const reactToMessage = (messageId: string) => {
    if (!activeRoomId) return;
    void mutate(async () => {
      await api("/api/collaboration/reactions", {
        method: "POST",
        body: JSON.stringify({ roomId: activeRoomId, messageId, emoji: "👍" }),
      });
    });
  };

  const pinMessage = (messageId: string) => {
    if (!activeRoomId) return;
    void mutate(async () => {
      await api("/api/collaboration/pins", {
        method: "POST",
        body: JSON.stringify({ roomId: activeRoomId, messageId }),
      });
    });
  };

  const saveMessage = (messageId: string) => {
    if (!activeRoomId) return;
    void mutate(async () => {
      await api("/api/collaboration/saved", {
        method: "POST",
        body: JSON.stringify({ roomId: activeRoomId, messageId }),
      });
    });
  };

  const followMessageThread = (messageId: string) => {
    if (!activeRoomId) return;
    void mutate(async () => {
      await api("/api/collaboration/follows", {
        method: "POST",
        body: JSON.stringify({ roomId: activeRoomId, threadRootMessageId: messageId }),
      });
    });
  };

  const openRoomMessage = (roomId: string, messageId: string) => {
    if (revokedRooms.current.has(roomId)) return;
    setRoomListTab("room");
    setMessageSource({ roomId, messageId });
    if (activeRoomRef.current === roomId) return;
    roomReadEpoch.current++;
    activeRoomRef.current = roomId;
    setDetail(null);
    setActiveRoomId(roomId);
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !message.trim() || !detail || busy) return;
    const roomId = activeRoomId;
    const text = message;
    const threadRootId = openThreadId || null;
    const optimistic: Message & { roomId: string } = {
      roomId, messageId: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      senderUserId: detail.currentUserId, senderActorId: `human:${detail.currentUserId}`,
      senderKind: "human", body: text.trim(), createdAt: Date.now(), threadRootId,
    };
    setBusy(true);
    void optimisticMutation({
      apply: () => { setPendingMessages((current) => [...current, optimistic]); updateMessageDraft(threadRootId ?? "", () => ""); },
      commit: () => api<{ message: Message }>(
        `/api/collaboration/rooms/${encodeURIComponent(roomId)}/messages`,
        request("POST", { body: text, messageId: optimistic.messageId,
          ...(threadRootId ? { threadRootMessageId: threadRootId } : {}) }),
      ),
      reconcile: (result) => {
        const patches = messagePatches.current.get(roomId) ?? new Map<string, Message>();
        patches.set(result.message.messageId, { ...result.message, threadRootId });
        messagePatches.current.set(roomId, patches);
        setPendingMessages((current) => current.filter((item) => item.messageId !== optimistic.messageId));
        setDetail((current) => current?.room.roomId === roomId ? { ...current,
          messages: [...current.messages.filter((item) => item.messageId !== result.message.messageId),
            { ...result.message, threadRootId }],
        } : current);
      },
      rollback: () => {
        setPendingMessages((current) => current.filter((item) => item.messageId !== optimistic.messageId));
        if (activeRoomRef.current === roomId) updateMessageDraft(threadRootId ?? "", (current) => current || text);
      },
      onError: (cause) => {
        toast.error(cause instanceof Error ? cause.message : "Message could not be sent.");
        if (activeRoomRef.current === roomId && isMembershipLost(cause)) loseRoomAccess(roomId);
      },
    }).finally(() => setBusy(false));
  };

  const createHandoff = (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !taskId.trim() || !recipientActorId || parentUnavailable) return;
    if (personalExecutionMode && (!personalGrant || personalGrant.snapshot.expiresAt <= Date.now())) {
      setError("Choose a current personal account grant before requesting this task. No deployment account will be substituted.");
      return;
    }
    const selectedNotes = selectedMemoryIds.map((id) =>
      (detail?.memory ?? []).find((note) => note.id === id && note.revokedAt === null),
    );
    if (selectedNotes.some((note) => !note)) {
      setError(
        "A selected shared note was revoked. Review the shared notes before requesting work.",
      );
      return;
    }
    const expectedDeliverables = deliverablePath
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    if (workDestination === "artifact-workspace" && expectedDeliverables.length === 0) {
      setError("Add at least one requested deliverable path.");
      return;
    }
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
          ...(selectedMessageIds.length > 0 ? { contextMessageIds: selectedMessageIds } : {}),
          ...(selectedNotes.length > 0
            ? {
                memoryRefs: selectedNotes.map((note) => ({
                  id: note!.id,
                  version: note!.version,
                  sha256: note!.sha256,
                })),
              }
            : {}),
          ...(personalExecutionMode && personalGrant
            ? { personalExecution: { grantId: personalGrant.snapshot.grantId, expectedVersion: personalGrant.version } }
            : {}),
          ...(!personalExecutionMode && workDestination === "artifact-workspace"
            ? {
                executionTarget: {
                  kind: "artifact-workspace",
                  expectedDeliverables,
                },
              }
            : {}),
          ...(!personalExecutionMode && executionTarget === "sandbox"
            ? { runtime: "sandbox" }
            : !personalExecutionMode ? { runtime: "local", targetMachineId: executionTarget.slice("local:".length) } : {}),
          ...(!personalExecutionMode && workDestination === "repository" && repoUrl.trim()
            ? { repoUrl: repoUrl.trim() }
            : {}),
          ...(parentHandoffId ? { parentHandoffId } : {}),
        }),
      );
      setTaskId("");
      setTask("");
      setRepoUrl("");
      setWorkDestination("repository");
      setDeliverablePath("reports/employee-summary.md");
      setParentHandoffId("");
      setHandoffRequestId("");
      setSelectedMemoryIds([]);
      setSelectedMessageIds([]);
    });
  };

  const reassignHandoff = (recipientActorId: string, item: Message) => {
    const source = detail?.messages.find((message) => message.messageId === item.threadRootId);
    if (busy || !activeRoomId || !source?.body.trim()) return;
    void mutate(async () => {
      await api(
        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/handoffs`,
        request("POST", {
          handoffId: `ho_${crypto.randomUUID()}`,
          taskId: `reassign_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          recipientActorId,
          task: source.body,
          contextMessageIds: [source.messageId],
        }),
      );
    });
  };

  return (
    <section
      aria-label="Team conversations"
      className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[var(--paper)] text-[var(--ink)]"
    >
      <div className="flex min-h-full min-w-0 flex-col gap-3 p-3 sm:p-5">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-2)]">
              {workspaceId ? "Workspace" : "Personal"} / team chat
            </p>
            <h1 className="font-serif text-2xl">Team conversations</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="max-w-sm text-xs text-[var(--ink-2)]">
              Chat with your team. Request employee work separately for human approval.
            </p>
            <NotificationsPanel
              workspaceId={workspaceId}
              onOpenSource={(item) => { if (item.roomId && item.messageId) openRoomMessage(item.roomId, item.messageId); }}
              onOpenPreferences={onOpenNotificationPreferences}
            />
          </div>
        </header>

        {error && (
          <p
            role="alert"
            className="min-h-11 rounded-none border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-sm"
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

        <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)] min-h-[70vh]">
          <RoomRail
            roomListTab={roomListTab}
            tabUnread={tabUnread}
            rooms={rooms}
            activePresenceCount={new Set(realtime.viewers.filter((viewer) => viewer.status === "online").map((viewer) => viewer.label)).size}
            savedItems={savedItems}
            activeRoomId={activeRoomId}
            roomTitle={roomTitle}
            roomVisibility={roomVisibility}
            busy={busy}
            onTab={(tab) => {
              setRoomListTab(tab);
              if (tab === "saved") {
                setMessageSource(null);
                setDetail(null);
                activeRoomRef.current = "";
                setActiveRoomId("");
              }
            }}
            onCreate={createRoom}
            onTitle={setRoomTitle}
            onVisibility={setRoomVisibility}
            onOpenSaved={openRoomMessage}
            onSelectRoom={(roomId) => {
              if (activeRoomRef.current === roomId) return;
              roomReadEpoch.current++;
              activeRoomRef.current = roomId;
              setMessageSource(null);
              setDetail(null);
              setActiveRoomId(roomId);
            }}
          />

          <main className="flex min-h-0 min-w-0 flex-col border border-[var(--line)] bg-[var(--card)]">
            {detail ? (
              <>
                <div className="border-b border-[var(--line)] px-4 py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--ink-2)]">
                      Group conversation · {detail.room.visibility}
                    </p>
                    <h2 className="break-words font-serif text-xl">{detail.room.title}</h2>
                    {workspaceId && <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button type="button" className="min-h-11 border border-[var(--line)] px-3 text-xs" onClick={async () => {
                        const roomId = activeRoomId;
                        let url: string;
                        try {
                          url = roomLinkUrl({ workspaceId, roomId }, window.location.origin);
                        } catch {
                          setCopyLinkStatus("This room has no shareable link.");
                          return;
                        }
                        try {
                          await navigator.clipboard.writeText(url);
                          if (activeRoomRef.current === roomId) setCopyLinkStatus("Room link copied. Recipients still need workspace and room access.");
                        } catch {
                          if (activeRoomRef.current === roomId) setCopyLinkStatus("Could not copy room link. Check clipboard permission and try again.");
                        }
                      }}>Copy room link</button>
                      {copyLinkStatus && <p role="status" className="text-xs text-[var(--ink-2)]">{copyLinkStatus}</p>}
                    </div>}

                    <p className="text-[10px] text-[var(--ink-2)]">
                      {members.length} active members
                    </p>
                    <p
                      role="status"
                      aria-label="Room live connection"
                      className="text-[10px] text-[var(--ink-2)]"
                    >
                      {realtime.status === "connected"
                        ? "Live updates connected"
                        : "Checking for updates"}
                      {realtime.viewers.length > 0 && ` · ${realtime.viewers.length} online`}
                    </p>
                    {roomOwner ? <OwnerChip owner={roomOwner} /> : null}
                    {presence.length > 0 ? (
                      <ul aria-label="Room presence" className="mt-1 flex flex-wrap gap-x-3">
                        {presence.map((person) => (
                          <li key={person.actorId}>
                            <PresenceChip state={person.state} label={person.label} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-1"><PresenceStack viewers={realtime.viewers} selfViewerId={realtime.viewerId} /></div>
                    {typing ? <p role="status" aria-label="Typing" className="mt-1 text-[10px] text-[var(--ink-2)]">{typing}</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetailTab("work")}
                    className="min-h-11 border border-[var(--line)] px-3 text-xs hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]"
                  >
                    Request employee work
                  </button>
                  <div className="w-full border-t border-[var(--line)] pt-2 font-mono text-[10px] text-[var(--ink-2)]">
                    {selectedMessageIds.length} messages · {selectedMemoryIds.length} notes selected
                    for the next approved task
                  </div>
                </div>

                <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] flex-1 min-h-0">
                  <div
                    data-testid="collaboration-chat-pane"
                    className="relative flex min-h-[400px] min-w-0 flex-col overflow-hidden border-b border-[var(--line)] xl:border-b-0 xl:border-r"
                    onPointerMove={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      if (bounds.width <= 0 || bounds.height <= 0) return;
                      realtime.publishCursor({ x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) });
                    }}
                    onPointerLeave={() => realtime.publishCursor(null)}
                    onPointerCancel={() => realtime.publishCursor(null)}
                  >
                    <div aria-hidden="true" data-testid="collaboration-cursors" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
                      {realtime.viewers.map((viewer) => {
                        const cursor = viewer.cursor;
                        if (!cursor || viewer.viewerId === realtime.viewerId || viewer.label === detail.currentUserId) return null;
                        return <div key={viewer.viewerId} data-room-cursor-viewer={viewer.viewerId} className="absolute text-[var(--navy)]" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}><svg aria-hidden="true" width="16" height="19" viewBox="0 0 16 19" className="block"><path d="M1 1V14L5 10L8 17L11 15L7 9H14Z" fill="currentColor" stroke="var(--paper)" strokeWidth="1" /></svg><span className="ml-3 block max-w-40 truncate border border-[var(--line)] bg-[var(--card)] px-1 py-0.5 font-mono text-[9px]">{viewer.label}</span></div>;
                      })}
                    </div>
                    {messageSource?.roomId === detail.room.roomId && !linkedMessage ? (
                      <p role="status" className="px-3 py-2 text-sm text-[var(--ink-2)]">This message isn't in the available conversation history.</p>
                    ) : null}
                    <MessageList>
                      {[...detail.messages, ...pendingMessages.filter((item) => item.roomId === activeRoomId && !detail.messages.some((saved) => saved.messageId === item.messageId))].map((item) => (
                        <MessageRow key={item.messageId} id={messageElementId(workspaceId, detail.room.roomId, item.messageId)} agent={item.senderKind === "agent"}>
                          {pendingMessages.some((pending) => pending.messageId === item.messageId) ? <span role="status" className="text-xs text-[var(--ink-2)]">Sending…</span> : null}
                          <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--ink-2)]">
                            <span className="font-semibold text-[var(--ink)]">
                              {item.sourceSlackUserId
                                ? `Slack user ${item.sourceSlackUserId}`
                                : item.senderKind === "agent"
                                  ? (members.find((member) => member.actorId === item.senderActorId)
                                      ?.displayName ?? "Employee")
                                  : (members.find(
                                      (member) =>
                                        member.userId === item.senderUserId &&
                                        member.actorKind === "human",
                                    )?.displayName ?? item.senderUserId)}
                            </span>
                            <span className="font-mono uppercase text-[9px]">
                              {item.sourceSlackUserId
                                ? "Slack"
                                : item.senderKind === "agent"
                                  ? "Employee"
                                  : "Person"}
                            </span>
                            <time
                              dateTime={new Date(item.createdAt).toISOString()}
                              className="ml-auto shrink-0 font-mono text-[9px]"
                            >
                              {new Date(item.createdAt).toLocaleString()}
                            </time>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
                          <MessageCards
                            message={{
                              messageKind: item.messageKind,
                              body: item.body,
                              fromLabel: item.senderKind === "agent" ? (members.find((member) => member.actorId === item.senderActorId)?.displayName ?? "Fixer") : undefined,
                              toLabel: members.find((member) => member.actorId === messagePayload(item.payloadJson).actorId)?.displayName,
                              handoffStatus: item.messageKind === "handoff" ? handoffCardStatus(item, detail) : undefined,
                              routerCandidates: members
                                .filter((member) => member.actorKind === "agent" && member.status === "active")
                                .map((member) => ({ actorId: member.actorId, name: member.displayName })),
                            }}
                            onOpenThread={cardThreadId(item, detail) ? () => setOpenThreadId(cardThreadId(item, detail) ?? "") : undefined}
                            reassignDisabled={busy}
                            onReassign={detail.messages.some((message) => message.messageId === item.threadRootId && message.body.trim())
                              ? (actorId) => reassignHandoff(actorId, item) : undefined}
                          />
                          {!item.threadRootId ? (
                            <button
                              type="button"
                              className="mt-2 min-h-11 px-2 text-[10px] underline"
                              onClick={() => setOpenThreadId(item.messageId)}
                            >
                              Open thread
                            </button>
                          ) : null}
                          <div
                            role="toolbar"
                            aria-label="Message actions"
                            className="mt-2 flex flex-wrap gap-1 border-t border-[var(--line)] pt-2"
                          >
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => reactToMessage(item.messageId)}
                              className="min-h-11 px-2 text-[10px] underline disabled:opacity-50"
                            >
                              React
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => pinMessage(item.messageId)}
                              className="min-h-11 px-2 text-[10px] underline disabled:opacity-50"
                            >
                              Pin
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => saveMessage(item.messageId)}
                              className="min-h-11 px-2 text-[10px] underline disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => followMessageThread(item.messageId)}
                              className="min-h-11 px-2 text-[10px] underline disabled:opacity-50"
                            >
                              Follow thread
                            </button>
                          </div>
                          <label className="mt-2 flex min-h-11 items-center gap-2 text-[10px] text-[var(--ink-2)]">
                            <input
                              type="checkbox"
                              aria-label={`Include message in next handoff: ${item.body.slice(0, 80)}`}
                              checked={selectedMessageIds.includes(item.messageId)}
                              disabled={
                                busy ||
                                (!selectedMessageIds.includes(item.messageId) &&
                                  selectedMessageIds.length >= 12)
                              }
                              onChange={(event) => {
                                setSelectedMessageIds((current) =>
                                  event.target.checked
                                    ? [...current, item.messageId]
                                    : current.filter((id) => id !== item.messageId),
                                );
                                setHandoffRequestId("");
                              }}
                            />
                            Include in next handoff
                          </label>
                          {item.sourceRunId && (
                            <div className="mt-2 border-t border-[var(--line)] pt-2 text-[10px]">
                              <p>Completed run: {item.sourceRunId}</p>
                              {item.sourceArtifactRefs?.map((artifact) =>
                                item.sourceHandoffId ? (
                                  <span key={`${item.messageId}-${artifact.index}`}>
                                    <a
                                      href={`/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/handoffs/${encodeURIComponent(item.sourceHandoffId)}/artifacts/${artifact.index}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`}
                                      className="mr-2 underline"
                                    >
                                      {artifact.path}
                                    </a>
                                    {artifact.artifactId && artifact.version && artifact.sha256 && (
                                      <ArtifactReviewControls
                                        key={JSON.stringify([workspaceId, activeRoomId, item.sourceHandoffId, artifact.artifactId, artifact.version, artifact.sha256])}
                                        artifactUrl={`/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/handoffs/${encodeURIComponent(item.sourceHandoffId)}/artifacts/${artifact.index}`}
                                        workspaceId={workspaceId}
                                      />
                                    )}
                                  </span>
                                ) : (
                                  <span
                                    key={`${item.messageId}-${artifact.index}`}
                                    className="mr-2"
                                  >
                                    {artifact.path}
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                          {item.messageKind === "shared_deliverable" && item.sourceArtifactRefs?.[0] && (
                            <div className="mt-2 border-t border-[var(--line)] pt-2">
                              <DeliverablePreview
                                src={`/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/shared-deliverables/${encodeURIComponent(item.messageId)}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`}
                                path={item.sourceArtifactRefs[0].path}
                                bytes={item.sourceArtifactRefs[0].bytes}
                                downloadHref={`/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/shared-deliverables/${encodeURIComponent(item.messageId)}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`}
                              />
                            </div>
                          )}
                          {item.sourceSlackEventId && (
                            <p className="mt-2 border-t border-[var(--line)] pt-2 text-[10px]">
                              Slack source · workspace {item.sourceSlackTeamId} · channel{" "}
                              {item.sourceSlackChannelId} · thread {item.sourceSlackThreadTs} ·
                              event {item.sourceSlackEventId}
                            </p>
                          )}
                          {item.senderKind === "human" &&
                            item.senderUserId === detail.currentUserId &&
                            !item.sourceSlackEventId &&
                            !item.sourceRunId &&
                            (detail.slackLinks ?? [])
                              .filter((link) => link.status === "active")
                              .map((link) => (
                                <button
                                  key={`${item.messageId}-${link.linkId}`}
                                  type="button"
                                  disabled={busy || !link.outboundConfigured}
                                  onClick={() =>
                                    queueSlackDeliveryIntent(item.messageId, link.linkId)
                                  }
                                  className="mt-2 mr-2 min-h-11 text-[10px] underline disabled:opacity-50"
                                >
                                  {link.outboundConfigured
                                    ? `Create Slack delivery intent for #${link.channelId} (not sent)`
                                    : `Slack delivery disabled for #${link.channelId}`}
                                </button>
                              ))}
                        </MessageRow>
                      ))}
                      {detail.messages.length === 0 && (
                        <p className="m-auto text-sm text-[var(--ink-2)]">
                          No messages yet. Share an update to bring the team together.
                        </p>
                      )}
                    </MessageList>
                    {openThreadId ? (
                      <ThreadPane title="Thread">
                        <button type="button" className="min-h-11 self-start text-xs underline" onClick={() => setOpenThreadId("")}>Close thread</button>
                        {detail.messages.filter((item) => item.threadRootId === openThreadId).map((item) => (
                          <p key={item.messageId} id={messageElementId(workspaceId, detail.room.roomId, item.messageId, true)} tabIndex={-1} className="text-sm">{item.body}</p>
                        ))}
                        {detail.messages.every((item) => item.threadRootId !== openThreadId) ? (
                          <p className="text-xs text-[var(--ink-2)]">No replies yet.</p>
                        ) : null}
                      </ThreadPane>
                    ) : null}
                    <form
                      onSubmit={sendMessage}
                      className="sticky bottom-0 flex flex-wrap gap-2 border-t border-[var(--line)] bg-[var(--card)] p-3"
                    >
                      <MentionMenu options={mentions.options} active={mentions.active} onPick={mentions.insert} />
                      <textarea
                        ref={messageInput}
                        aria-label="Message"
                        value={message}
                        onChange={(event) => mentions.onChange(event.target.value, event.target.selectionStart)}
                        onSelect={(event) => mentions.onSelect(event.currentTarget.selectionStart)}
                        onKeyDown={mentions.onKeyDown}
                        maxLength={5000}
                        rows={2}
                        placeholder={openThreadId ? "Reply in this thread…" : "Message this group…"}
                        className="min-w-0 flex-1 resize-y rounded-none border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm"
                      />
                      <button
                        type="submit"
                        disabled={busy || !message.trim()}
                        className="min-h-11 self-end rounded-none bg-[var(--navy)] px-4 py-2 text-xs font-semibold text-[var(--paper-title-fg)] disabled:opacity-50"
                      >
                        Send
                      </button>
                      <p className="w-full text-[10px] text-[var(--ink-2)]">
                        Visible to room members. Sending a message does not start an employee run.
                      </p>
                    </form>
                  </div>

                  <aside aria-label="Conversation details" className="min-w-0 bg-[var(--paper)]">
                    <div
                      role="tablist"
                      aria-label="Conversation detail views"
                      className="flex overflow-x-auto border-b border-[var(--line)]"
                      onKeyDown={(event) => {
                        const currentIndex = DETAIL_TABS.findIndex((tab) => tab.id === detailTab);
                        const nextIndex =
                          event.key === "ArrowRight"
                            ? (currentIndex + 1) % DETAIL_TABS.length
                            : event.key === "ArrowLeft"
                              ? (currentIndex + DETAIL_TABS.length - 1) % DETAIL_TABS.length
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? DETAIL_TABS.length - 1
                                  : -1;
                        if (nextIndex < 0) return;
                        event.preventDefault();
                        const next = DETAIL_TABS[nextIndex];
                        if (!next) return;
                        setDetailTab(next.id);
                        event.currentTarget
                          .querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)
                          ?.focus();
                      }}
                    >
                      {DETAIL_TABS.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          id={`collaboration-tab-${tab.id}`}
                          data-tab={tab.id}
                          aria-selected={detailTab === tab.id}
                          aria-controls={`collaboration-panel-${tab.id}`}
                          tabIndex={detailTab === tab.id ? 0 : -1}
                          onClick={() => setDetailTab(tab.id)}
                          className={`min-h-11 shrink-0 border-b-2 px-3 font-mono text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] ${detailTab === tab.id ? "border-[var(--navy)] text-[var(--ink)]" : "border-transparent text-[var(--ink-2)]"}`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <section
                      role="tabpanel"
                      id="collaboration-panel-members"
                      aria-labelledby="collaboration-tab-members"
                      hidden={detailTab !== "members"}
                      className="p-3"
                    >
                      <h3 className="mb-2 text-xs font-semibold">Members</h3>
                      <ul className="flex flex-col gap-1 text-xs">
                        {members.map((member) => (
                          <li
                            key={member.actorId}
                            className="flex items-center justify-between gap-2 rounded-none bg-[var(--card)] px-2 py-1.5"
                          >
                            <span className="truncate">
                              {member.displayName}{" "}
                              <span className="text-[var(--ink-2)]">· {member.role}</span>
                              {member.actorKind === "human" && member.status !== "removed" && memberLastSeen.scope === presenceScope && memberLastSeen.seen[member.userId] ? (
                                <span className="block text-[10px] text-[var(--ink-2)]">
                                  {realtime.viewers.some((viewer) => viewer.label === member.userId && viewer.status === "online") ? "online" : realtime.viewers.some((viewer) => viewer.label === member.userId) ? "away" : "offline"} · Last seen {new Date(memberLastSeen.seen[member.userId]!).toLocaleString()}
                                </span>
                              ) : null}
                            </span>
                            {member.actorKind === "human" && member.status !== "removed" && member.userId !== detail.currentUserId && (
                              <button type="button" disabled={busy} onClick={() => void startDirectMessage(member.userId)}
                                aria-label={`Message ${member.displayName}`} className="min-h-11 px-2 text-[var(--navy)]">
                                Message
                              </button>
                            )}
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
                                className="min-h-11 px-2 text-[var(--danger)]"
                              >
                                Remove
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {canManageMembers && (
                        <form onSubmit={inviteMember} className="mt-2 flex gap-2">
                          {workspaceId ? (
                            <select
                              aria-label="Workspace member"
                              value={inviteUserId}
                              onChange={(event) => setInviteUserId(event.target.value)}
                              disabled={!workspaceRoster || busy}
                              className="min-h-11 min-w-0 flex-1 border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                            >
                              <option value="">
                                {workspaceRosterUnavailable
                                  ? "Member list unavailable"
                                  : !workspaceRoster
                                    ? "Loading workspace members…"
                                    : "Choose a workspace member"}
                              </option>
                              {(workspaceRoster ?? [])
                                .filter(
                                  (candidate) =>
                                    !members.some(
                                      (member) =>
                                        member.actorKind === "human" &&
                                        member.userId === candidate.userId,
                                    ),
                                )
                                .map((candidate) => (
                                  <option key={candidate.userId} value={candidate.userId}>
                                    {candidate.userId} · {candidate.role}
                                  </option>
                                ))}
                            </select>
                          ) : (
                            <input
                              aria-label="Member user ID or email"
                              value={inviteUserId}
                              onChange={(event) => setInviteUserId(event.target.value)}
                              placeholder="User ID or email"
                              className="min-h-11 min-w-0 flex-1 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                            />
                          )}
                          <button
                            type="submit"
                            disabled={
                              busy ||
                              !inviteUserId.trim() ||
                              Boolean(workspaceId && !workspaceRoster)
                            }
                            className="min-h-11 rounded-none border border-[var(--line)] px-2 py-2 text-xs disabled:opacity-50"
                          >
                            Invite
                          </button>
                        </form>
                      )}
                      {workspaceId && workspaceRosterUnavailable && (
                        <p className="mt-2 text-xs text-[var(--ink-2)]">
                          Workspace members could not be loaded. Refresh to review membership before
                          inviting.
                        </p>
                      )}
                      {canManageMembers && (
                        <p className="mt-3 text-[10px] text-[var(--ink-2)]">
                          Add an employee explicitly to this group. Their private conversations and
                          memory are not imported.
                        </p>
                      )}
                      {canManageMembers && (
                        <div className="mt-2 flex gap-2">
                          <select
                            aria-label="Employee profile"
                            value={selectedProfileId}
                            onChange={(event) => setSelectedProfileId(event.target.value)}
                            className="min-h-11 min-w-0 flex-1 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
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
                            className="min-h-11 rounded-none border border-[var(--line)] px-2 py-2 text-xs disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                      )}
                    </section>

                    <section
                      role="tabpanel"
                      id="collaboration-panel-context"
                      aria-labelledby="collaboration-tab-context"
                      hidden={detailTab !== "context"}
                      className="p-3"
                    >
                      <h3 className="mb-2 text-xs font-semibold">Shared room notes</h3>
                      <p className="mb-2 text-[10px] text-[var(--ink-2)]">
                        Notes are visible to this room’s members. Select up to eight for the next
                        handoff; their exact versions are included in human approval.
                      </p>
                      <ul aria-label="Shared room notes" className="flex flex-col gap-2">
                        {(detail.memory ?? [])
                          .filter((note) => note.revokedAt === null)
                          .map((note) => (
                            <li
                              key={note.id}
                              className="rounded-none bg-[var(--card)] p-2 text-[10px]"
                            >
                              <label className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  aria-label={`Use shared note ${note.title} in next handoff`}
                                  checked={selectedMemoryIds.includes(note.id)}
                                  disabled={
                                    busy ||
                                    (!selectedMemoryIds.includes(note.id) &&
                                      selectedMemoryIds.length >= 8)
                                  }
                                  onChange={(event) => {
                                    setSelectedMemoryIds((current) =>
                                      event.target.checked
                                        ? [...current, note.id]
                                        : current.filter((id) => id !== note.id),
                                    );
                                    setHandoffRequestId("");
                                  }}
                                />
                                <span className="min-w-0 break-words font-semibold">
                                  {note.title} · v{note.version}
                                </span>
                              </label>
                              <p className="mt-1 whitespace-pre-wrap break-words">{note.content}</p>
                              <p className="mt-1 text-[var(--ink-2)]">
                                Shared by {note.createdByUserId}
                              </p>
                              {(canManageMembers ||
                                note.createdByUserId === detail.currentUserId) && (
                                <button
                                  type="button"
                                  aria-label={`Revoke shared note ${note.title}`}
                                  disabled={busy}
                                  onClick={() =>
                                    void mutate(() =>
                                      api(
                                        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/memory/${encodeURIComponent(note.id)}`,
                                        request("DELETE", { version: note.version }),
                                      ),
                                    )
                                  }
                                  className="mt-1 min-h-11 px-2 text-[var(--danger)] disabled:opacity-50"
                                >
                                  Revoke
                                </button>
                              )}
                            </li>
                          ))}
                      </ul>
                      <form
                        className="mt-2 flex flex-col gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!memoryTitle.trim() || !memoryContent.trim()) return;
                          void mutate(async () => {
                            await api(
                              `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/memory`,
                              request("POST", {
                                id: `ctx_${crypto.randomUUID()}`,
                                title: memoryTitle.trim(),
                                content: memoryContent.trim(),
                              }),
                            );
                            setMemoryTitle("");
                            setMemoryContent("");
                          });
                        }}
                      >
                        <input
                          aria-label="Shared note title"
                          value={memoryTitle}
                          onChange={(event) => setMemoryTitle(event.target.value)}
                          maxLength={120}
                          placeholder="Shared note title"
                          className="min-h-11 min-w-0 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                        />
                        <textarea
                          aria-label="Shared note content"
                          value={memoryContent}
                          onChange={(event) => setMemoryContent(event.target.value)}
                          maxLength={4000}
                          rows={3}
                          placeholder="Context to share with this room"
                          className="min-h-11 min-w-0 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                        />
                        <button
                          type="submit"
                          disabled={busy || !memoryTitle.trim() || !memoryContent.trim()}
                          className="min-h-11 rounded-none border border-[var(--line)] px-2 py-2 text-xs disabled:opacity-50"
                        >
                          Share note with room
                        </button>
                      </form>
                    </section>

                    <section
                      role="tabpanel"
                      id="collaboration-panel-slack"
                      aria-labelledby="collaboration-tab-slack"
                      hidden={detailTab !== "slack"}
                      className="p-3"
                    >
                      <h3 className="mb-2 text-xs font-semibold">Slack thread continuity</h3>
                      <p className="mb-2 text-[10px] text-[var(--ink-2)]">
                        Only Slack threads allowed by the configured owner and audience policy
                        appear here. Linking shares that exact thread with authorized room members.
                        Sending a room message to Slack requires separate approval.
                      </p>
                      {canManageMembers && (
                        <div className="flex gap-2">
                          <select
                            aria-label="Verified Slack thread"
                            value={selectedSlackSource}
                            onChange={(event) => setSelectedSlackSource(event.target.value)}
                            className="min-h-11 min-w-0 flex-1 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                          >
                            <option value="">Select observed thread</option>
                            {(detail.slackSources ?? [])
                              .filter((source) => !source.mappedRoomId)
                              .map((source) => (
                                <option
                                  key={`${source.teamId}|${source.channelId}|${source.threadTs}`}
                                  value={`${source.teamId}|${source.channelId}|${source.threadTs}`}
                                >
                                  {source.teamId} / {source.channelId} / {source.threadTs}
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            disabled={busy || !selectedSlackSource}
                            onClick={linkSlackSource}
                            className="min-h-11 rounded-none border border-[var(--line)] px-2 py-2 text-xs disabled:opacity-50"
                          >
                            Link
                          </button>
                        </div>
                      )}
                      <ul className="mt-2 flex flex-col gap-1 text-[10px]">
                        {(detail.slackLinks ?? []).map((link) => (
                          <li key={link.linkId} className="rounded-none bg-[var(--card)] p-2">
                            <div className="flex items-start justify-between gap-2">
                              <span className="break-all">
                                {link.status}: {link.teamId}/{link.channelId}/{link.threadTs}
                              </span>
                              {canManageMembers && link.status === "active" && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void mutate(() =>
                                      api(
                                        `/api/collaboration/rooms/${encodeURIComponent(activeRoomId)}/slack-links/${encodeURIComponent(link.linkId)}`,
                                        { method: "DELETE" },
                                      ),
                                    )
                                  }
                                  className="min-h-11 shrink-0 px-2 text-[var(--danger)]"
                                >
                                  Revoke
                                </button>
                              )}
                            </div>
                            {link.status === "active" && (
                              <p className="mt-1 text-[var(--ink-2)]">
                                {link.outboundConfigured
                                  ? "Room messages can create delivery intents; no Slack message is sent."
                                  : "Outbound delivery is disabled; configure the existing Slack approvals channel to create an intent."}
                              </p>
                            )}
                          </li>
                        ))}
                        {(detail.slackLinks ?? []).length === 0 && (
                          <li className="text-[var(--ink-2)]">No Slack threads linked.</li>
                        )}
                      </ul>
                      {(detail.slackDeliveryIntents ?? []).length > 0 && (
                        <ul
                          aria-label="Slack delivery intents"
                          className="mt-2 flex flex-col gap-1 text-[10px]"
                        >
                          {detail.slackDeliveryIntents?.map((intent) => (
                            <li key={intent.intentId}>
                              <p className="whitespace-pre-wrap break-words">
                                Approved content: {intent.content}
                              </p>
                              <span>
                                Delivery {intent.deliveryStatus} · #{intent.channelId}
                                {intent.receiptTs ? ` · Slack receipt ${intent.receiptTs}` : ""}
                                {intent.deliveryStatus === "unknown"
                                  ? " · outcome unknown; not retried"
                                  : ""}
                              </span>
                              {detail.canApproveSlackOutbox &&
                                detail.slackOutboxEnabled &&
                                intent.status === "pending" &&
                                intent.deliveryStatus === "awaiting_approval" && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => approveSlackDeliveryIntent(intent.intentId)}
                                    className="ml-2 min-h-11 px-2 underline disabled:opacity-50"
                                  >
                                    Approve and send
                                  </button>
                                )}
                              {intent.outcomeDetail && <p>{intent.outcomeDetail}</p>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section
                      role="tabpanel"
                      id="collaboration-panel-work"
                      aria-labelledby="collaboration-tab-work"
                      hidden={detailTab !== "work"}
                      className="p-3"
                    >
                      <h3 className="mb-2 text-xs font-semibold">Handoffs</h3>
                      {workspaceId && <div className="mb-3">
                        <label className="block text-xs">Account for this room task<select
                          aria-label="Account for this room task" value={personalExecutionMode ? "personal" : "deployment"}
                          onChange={(event) => {
                            setPersonalExecutionMode(event.target.value === "personal"); setPersonalGrant(null); personalGrantIntent.current = ""; setHandoffRequestId("");
                            if (event.target.value === "personal") { setWorkDestination("repository"); setParentHandoffId(""); }
                          }} className="mt-1 min-h-11 w-full min-w-0 border border-[var(--input-line)] bg-[var(--paper)] p-2 text-xs">
                          <option value="deployment">Existing deployment execution</option><option value="personal">My own Claude or Codex account</option>
                        </select></label>
                        {personalExecutionMode && detailTab === "work" && <div className="mt-2"><PersonalExecutionSetup key={`${workspaceId}:${activeRoomId}:${detail.currentUserId}`}
                          workspaceId={workspaceId} actorId={detail.currentUserId} selected={personalGrant}
                          onSelectionChange={(grant) => {
                            setPersonalGrant(grant);
                            if (grant) {
                              const intent = `${grant.snapshot.grantId}:${grant.version}`;
                              if (personalGrantIntent.current !== intent) { personalGrantIntent.current = intent; setHandoffRequestId(""); }
                            }
                          }} /></div>}
                      </div>}
                      {workspaceId && <div className="mb-3 border border-[var(--line)] p-3"><button type="button" className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs" onClick={() => setShowBootstrapVerification((shown) => !shown)}>{showBootstrapVerification ? "Close account verification" : "Check my account verification"}</button>{showBootstrapVerification && detailTab === "work" && <BootstrapVerificationPanel identityKey={`${workspaceId}:${activeRoomId}:${detail.currentUserId}`} />}</div>}
                      {workspaceId && <div className="mb-3 border border-[var(--line)] p-3"><button type="button" className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs" onClick={() => setShowTeamModels((shown) => !shown)}>{showTeamModels ? "Close funded text sessions" : "Open funded team text sessions"}</button>{showTeamModels && detailTab === "work" && <TeamModelSessions workspaceId={workspaceId} roomId={activeRoomId} actorId={detail.currentUserId}
                        messages={detail.messages.filter((item) => item.senderKind === "human" && !item.sourceSlackEventId && !item.sourceSlackTeamId && !item.sourceSlackChannelId && !item.sourceSlackThreadTs && !item.sourceSlackUserId && !item.sourceRunId && !item.sourceHandoffId && !item.sourceArtifactRefs?.length).map((item) => ({ id: item.messageId, author: item.senderUserId, body: item.body }))}
                        notes={(detail.memory ?? []).filter((note) => note.revokedAt === null).map((note) => ({ id: note.id, version: note.version, sha256: note.sha256, title: note.title, body: note.content }))} />}</div>}
                      {workspaceId && <div className="mb-3 border border-[var(--line)] p-3">
                        <button type="button" className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs" aria-expanded={showSharedComputer} onClick={() => setShowSharedComputer((shown) => !shown)}>
                          {showSharedComputer ? "Close shared computer" : "Open shared computer"}
                        </button>
                        {showSharedComputer && detailTab === "work" && <SharedComputerSessions key={`${workspaceId}:${activeRoomId}:${detail.currentUserId}`} workspaceId={workspaceId} roomId={activeRoomId} actorId={detail.currentUserId} />}
                      </div>}
                      {reviewableSlackDraft && incomingTaskDraft && <section aria-label={incomingTaskDraft.source === "team-onboarding" ? "Review saved team task" : "Review Slack draft"} className="mb-3 min-w-0 space-y-2 border border-[var(--line)] bg-[var(--paper)] p-3 text-xs">
                        {incomingTaskDraft.source === "team-onboarding" ? <><p className="font-semibold">Review saved team task</p><p>Saved draft version {incomingTaskDraft.draftTaskVersion} · progress revision {incomingTaskDraft.progressRevision}</p><p>Review before using in room {detail.room.title}. This creates an editable copy; later setup edits do not update it, and the saved version may no longer be current. It grants no employee, source, or tool access. Submitting a room task can share its instructions with room participants and requires normal approval.</p></> : <><p className="font-semibold">Untrusted self-authored Slack statement</p><p>Review before using in room {detail.room.title}. Submitting a room task can share its instructions with that room's participants. Copying here does not send a task or share room context; later Slack edits cannot retract the copied text.</p></>}
                        <blockquote className="whitespace-pre-wrap break-words">{incomingTaskDraft.text}</blockquote>
                        {!validSlackDraft && <p role="alert">This draft must contain 1–4,000 characters before it can be used. It has not been shortened.</p>}
                        {task && !replaceReviewed && <p>Your current unsent task will be preserved unless you explicitly confirm its replacement.</p>}
                        {task && !replaceReviewed ? <button type="button" className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] disabled:opacity-50" disabled={!validSlackDraft || busy} onClick={() => setDraftReplacement({ id: incomingTaskDraft.id, roomId: activeRoomId, previousTask: task, text: incomingTaskDraft.text, provenance: draftProvenance })}>Review replacing my unsent task</button>
                          : <button type="button" className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] disabled:opacity-50" disabled={!validSlackDraft || busy} onClick={useSlackDraft}>{task ? "Confirm replacing my unsent task" : incomingTaskDraft.source === "team-onboarding" ? "Use saved task in this room" : "Use Slack draft in this room task"}</button>}
                      </section>}
                      <form onSubmit={createHandoff} className="flex flex-col gap-2">
                        <input
                          aria-label="Task ID"
                          value={taskId}
                          onChange={(event) => {
                            setTaskId(event.target.value);
                            setHandoffRequestId("");
                          }}
                          maxLength={120}
                          placeholder="Task ID / grouping key"
                          className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                        />
                        <p className="text-[10px] text-[var(--ink-2)]">
                          Task instructions, selected messages, notes and employee profile must fit
                          the 4,000-character approval limit. Oversized context is rejected; choose
                          short, relevant sources.
                        </p>
                        <textarea
                          aria-label="Employee task request"
                          value={task}
                          onChange={(event) => {
                            setTask(event.target.value);
                            setHandoffRequestId("");
                          }}
                          maxLength={4000}
                          rows={3}
                          placeholder="Describe the work to request"
                          className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                        />
                        <select
                          aria-label="Employee work destination"
                          value={workDestination}
                          disabled={personalExecutionMode}
                          onChange={(event) => {
                            const next = event.target.value as "repository" | "artifact-workspace";
                            setWorkDestination(next);
                            setHandoffRequestId("");
                          }}
                          className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                        >
                          <option value="repository">Repository</option>
                          <option value="artifact-workspace">
                            Artifact workspace (no repository)
                          </option>
                        </select>
                        {personalExecutionMode ? <p className="break-words text-xs text-[var(--ink-2)]">{personalGrant
                          ? `Pinned personal task: ${personalGrant.snapshot.repoUrl} · ${personalGrant.snapshot.codingModel}. The server resolves the selected account and machine from grant v${personalGrant.version}.`
                          : "Select a current personal grant above. Public repository tasks only; cloud and deployment-machine execution stay unavailable in this mode."}</p> : workDestination === "artifact-workspace" ? (
                          <>
                            <textarea
                              aria-label="Expected deliverable paths"
                              value={deliverablePath}
                              onChange={(event) => {
                                setDeliverablePath(event.target.value);
                                setHandoffRequestId("");
                              }}
                              rows={2}
                              placeholder="One safe .md, .txt, .json or .csv output path per line"
                              className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                            />
                            <p className="text-[10px] text-[var(--ink-2)]">
                              Repo-free work runs on the selected execution target and must produce
                              the listed files.
                            </p>
                          </>
                        ) : (
                          <>
                            <input
                              aria-label="Repository URL"
                              value={repoUrl}
                              onChange={(event) => {
                                setRepoUrl(event.target.value);
                                setHandoffRequestId("");
                              }}
                              maxLength={500}
                              placeholder="Repository URL (uses employee default when blank)"
                              className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                            />
                          </>
                        )}
                        {!personalExecutionMode && (
                          <select
                            aria-label="Employee execution target"
                            value={executionTarget}
                            onChange={(event) => {
                              setExecutionTarget(event.target.value);
                              setHandoffRequestId("");
                            }}
                            className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                          >
                            <option value="sandbox">Cloud sandbox</option>
                            {computers.map((computer) => (
                              <option
                                key={computer.machineId}
                                value={`local:${computer.machineId}`}
                              >
                                Local · {computer.hostname}
                                {computer.status === "busy" ? " (busy)" : ""}
                              </option>
                            ))}
                          </select>
                        )}
                        <p className="text-[10px] text-[var(--ink-2)]">
                          Employee app-tool grants cover only supported Shiba Worker actions. Coding
                          harness shell and CLI access are separate and are not restricted by those
                          app-tool grants.
                        </p>
                        <select
                          aria-label="Parent handoff"
                          value={parentHandoffId}
                          disabled={personalExecutionMode}
                          onChange={(event) => {
                            setParentHandoffId(event.target.value);
                            setHandoffRequestId("");
                          }}
                          className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
                        >
                          <option value="">New task handoff</option>
                          {parentUnavailable && <option value={parentHandoffId} disabled>Selected handoff can no longer be continued</option>}
                          {parentHandoffs.map((handoff) => (
                            <option key={handoff.handoffId} value={handoff.handoffId}>
                              Continue {handoff.handoffId.slice(-8)} · depth {handoff.depth}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Handoff recipient"
                          value={recipientActorId}
                          onChange={(event) => {
                            setRecipientActorId(event.target.value);
                            setHandoffRequestId("");
                          }}
                          className="min-h-11 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
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
                          disabled={busy || parentUnavailable || !taskId.trim() || !recipientActorId || !task.trim() || (personalExecutionMode && !personalGrant)}
                          className="min-h-11 rounded-none border border-[var(--line)] px-2 py-2 text-xs disabled:opacity-50"
                        >
                          Request / create handoff
                        </button>
                      </form>
                      <ul className="mt-3 flex flex-col gap-2">
                        {detail.handoffs.map((handoff) => (
                          <li
                            key={handoff.handoffId}
                            id={handoffElementId(workspaceId, activeRoomId, handoff.handoffId)}
                            tabIndex={-1}
                            className="rounded-none bg-[var(--card)] p-2 text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <strong className="truncate">{handoff.taskId}</strong>
                              <span>{handoff.status}</span>
                            </div>
                            <p className="mt-1 break-words text-[var(--ink-2)]">
                              {members.find((member) => member.actorId === handoff.senderActorId)?.displayName ?? handoff.senderActorId}
                              {" handed to @"}{members.find((member) => member.actorId === handoff.recipientActorId)?.displayName ?? handoff.recipientActorId}
                            </p>
                            {handoff.humanRequest && (
                              <div className="my-2 border-t border-[var(--line)] pt-2">
                                <p className="font-semibold">Human assignment</p>
                                <p className="mt-1 break-words">Assigned to {members.find((member) => member.actorId === handoff.recipientActorId)?.displayName ?? handoff.recipientActorId}</p>
                                <section aria-label="Assignment instructions"><p className="mt-1 whitespace-pre-wrap break-words">{handoff.humanRequest.instructions}</p></section>
                                <p className="mt-1 break-words text-[var(--ink-2)]">Requested by {handoff.humanRequest.requestedByUserId} · {handoff.humanRequest.messageCount} messages · {handoff.humanRequest.noteCount} notes</p>
                                {handoff.humanRequest.messageCount + handoff.humanRequest.noteCount > 0 && <details className="mt-2"><summary className="min-h-11 cursor-pointer py-2">Frozen assignment context</summary><p className="whitespace-pre-wrap break-words">{handoff.humanRequest.task}</p></details>}
                                <p className="mt-1 break-all font-mono text-[9px] text-[var(--ink-2)]">SHA-256 {handoff.humanRequest.digest}</p>
                              </div>
                            )}
                            {handoff.execution?.unavailable && !handoff.approvalId && <p className="my-2 text-[var(--ink-2)]">Assignment context is unavailable. A source or membership changed.</p>}
                            <p className="mt-1 text-[var(--ink-2)]">
                              Depth {handoff.depth} · {handoff.currentRootBudget ?? 0} handoffs left in this chain
                            </p>
                            {handoff.approvalId && (
                              <div className="mt-1 border-t border-[var(--line)] pt-1">
                                <p>Approval: {handoff.execution?.approvalStatus ?? "unknown"}</p>
                                {handoff.execution?.runStatus && (
                                  <p>Run: {handoff.execution.runStatus}</p>
                                )}
                                {handoff.execution?.error && (
                                  <p className="min-h-11 px-2 text-[var(--danger)]">
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
                                className="mt-1 min-h-11 px-2 text-[var(--danger)]"
                              >
                                Take it back
                              </button>
                            )}
                            {handoff.status === "active" && handoff.approvalId && handoff.execution?.approvalStatus === "pending" && renderApproval?.({ ...handoff, roomId: activeRoomId })}
                          </li>
                        ))}
                        {detail.handoffs.length === 0 && (
                          <li className="text-[10px] text-[var(--ink-2)]">No handoffs yet.</li>
                        )}
                      </ul>
                    </section>
                    <section
                      role="tabpanel"
                      id="collaboration-panel-execution"
                      aria-labelledby="collaboration-tab-execution"
                      hidden={detailTab !== "execution"}
                      className="p-3"
                    >
                      <h3 className="mb-2 text-xs font-semibold">Shared execution</h3>
                      <p className="mb-3 text-xs text-[var(--ink-2)]">
                        Read-only activity from approved room tasks. Computer control and private
                        employee sessions are not shared here.
                      </p>
                      {detailTab === "execution" &&
                        detail.handoffs.map((handoff) => (
                          <div
                            key={handoff.handoffId}
                            className="mb-3 min-w-0 border border-[var(--line)] p-3"
                          >
                            <h4 className="mb-2 break-words text-xs font-semibold">
                              {handoff.taskId}
                            </h4>
                            {hasApprovedRoomRun(handoff) && renderExecution ? (
                              renderExecution({ ...handoff, roomId: activeRoomId })
                            ) : (
                              <p className="text-xs text-[var(--ink-2)]">
                                {handoff.execution?.unavailable
                                  ? "Run activity is unavailable for this room."
                                  : hasApprovedRoomRun(handoff)
                                    ? "Live execution view is not available in this surface."
                                    : handoff.execution?.approvalStatus === "approved"
                                      ? "Run activity has not been verified."
                                      : "Waiting for a human-approved run."}
                              </p>
                            )}
                          </div>
                        ))}
                      {detail.handoffs.length === 0 && (
                        <p className="text-xs text-[var(--ink-2)]">
                          Request employee work to create an approval and share its results here.
                        </p>
                      )}
                    </section>
                  </aside>
                </div>
              </>
            ) : (
              <div className="m-auto p-8 text-center text-sm text-[var(--ink-2)]">
                Choose a group chat or create one for your team.
              </div>
            )}
          </main>
        </div>
      </div>
    </section>
  );
}
