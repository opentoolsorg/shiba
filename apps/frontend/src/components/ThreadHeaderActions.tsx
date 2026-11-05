import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import {
  Archive,
  Copy,
  Edit2,
  MoreHorizontal,
  Share2,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { ConversationRoomViewer } from "../conversation-room-realtime";

export type ParticipantRole = "Moderator" | "Agent" | "Member";

export interface ThreadParticipant {
  id: string;
  name: string;
  role: ParticipantRole;
  online: boolean;
  isSelf?: boolean;
}

export interface ThreadHeaderActionsProps {
  viewers?: readonly ConversationRoomViewer[];
  viewerId?: string;
  currentUserName?: string;
  participants?: ThreadParticipant[];

  // People / Invite support
  canInvite?: boolean;
  onAddPeople?: () => void;

  // Real thread actions supported by Shiba
  sessionId?: string;
  threadUrl?: string;
  onShareLink?: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onClear?: () => void;

  className?: string;
}

/**
 * ThreadHeaderActions — Header toolbar for thread views.
 *
 * - People button with participant count toggles a "People · N in this room" panel.
 * - Displays avatar, name, role (Moderator/Agent/Member), and presence dot (green online / gray offline).
 * - "Add people" action shown only if Shiba supports inviting into that room.
 * - "…" menu containing only real supported Shiba actions: Share link, Rename, Archive, Clear.
 */
export function ThreadHeaderActions({
  viewers = [],
  viewerId,
  currentUserName,
  participants: customParticipants,
  canInvite = false,
  onAddPeople,
  sessionId,
  threadUrl,
  onShareLink,
  onRename,
  onArchive,
  onClear,
  className = "",
}: ThreadHeaderActionsProps): JSX.Element {
  const [isPeopleOpen, setIsPeopleOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const peopleRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        peopleRef.current &&
        !peopleRef.current.contains(event.target as Node)
      ) {
        setIsPeopleOpen(false);
      }
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsPeopleOpen(false);
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Compute resolved participant list
  const resolvedParticipants = useMemo<ThreadParticipant[]>(() => {
    if (customParticipants && customParticipants.length > 0) {
      return customParticipants;
    }

    if (viewers.length > 0) {
      return viewers.map((v) => {
        const isSelf = Boolean(viewerId && v.viewerId === viewerId);
        const name = v.label || (isSelf ? currentUserName || "You" : `Viewer (${v.viewerId.slice(0, 4)})`);
        let role: ParticipantRole = "Member";
        if (
          name.toLowerCase().includes("agent") ||
          name.toLowerCase().includes("shiba")
        ) {
          role = "Agent";
        } else if (isSelf) {
          role = "Moderator";
        }
        return {
          id: v.viewerId,
          name,
          role,
          online: true,
          isSelf,
        };
      });
    }

    // Fallback: at least current viewer is present
    return [
      {
        id: viewerId || "self",
        name: currentUserName || "You",
        role: "Moderator",
        online: true,
        isSelf: true,
      },
      {
        id: "shiba-agent",
        name: "Shiba Agent",
        role: "Agent",
        online: true,
      },
    ];
  }, [customParticipants, viewers, viewerId, currentUserName]);

  const participantCount = resolvedParticipants.length;

  const handleShare = async () => {
    if (onShareLink) {
      onShareLink();
    } else {
      const link =
        threadUrl ||
        (typeof window !== "undefined" ? window.location.href : "");
      if (link && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(link).catch(() => {});
        toast("Link copied to clipboard");
      }
    }
    setIsMenuOpen(false);
  };

  const handleRename = () => {
    setIsMenuOpen(false);
    onRename?.();
  };

  const handleArchive = () => {
    setIsMenuOpen(false);
    onArchive?.();
  };

  const handleClear = () => {
    setIsMenuOpen(false);
    onClear?.();
  };

  const showAddPeople = Boolean(canInvite || onAddPeople);

  return (
    <div className={`relative flex items-center gap-1.5 ${className}`.trim()}>
      {/* People Toggle Button */}
      <div ref={peopleRef} className="relative">
        <button
          type="button"
          onClick={() => {
            setIsPeopleOpen(!isPeopleOpen);
            setIsMenuOpen(false);
          }}
          aria-label={`People · ${participantCount} in this room`}
          aria-expanded={isPeopleOpen}
          className={`h-7 px-2 rounded-md flex items-center gap-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 ${
            isPeopleOpen
              ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100"
              : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60"
          }`}
        >
          <Users className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          <span>{participantCount}</span>
        </button>

        {/* People Panel Popover */}
        {isPeopleOpen ? (
          <div
            role="dialog"
            aria-label={`People · ${participantCount} in this room`}
            className="absolute right-0 top-full mt-1.5 w-64 rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-[#18181b] p-3 shadow-lg z-50 animate-in fade-in-50 zoom-in-95 duration-100"
          >
            <div className="flex items-center justify-between pb-2 border-b border-[#e4e4e7] dark:border-zinc-800">
              <span className="text-[13px] font-semibold text-[#0a0a0a] dark:text-zinc-100">
                People · {participantCount} in this room
              </span>
              <button
                type="button"
                onClick={() => setIsPeopleOpen(false)}
                aria-label="Close people panel"
                className="size-5 rounded flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            </div>

            <ul
              aria-label="Room participants"
              className="flex flex-col gap-1 py-2 max-h-56 overflow-y-auto"
            >
              {resolvedParticipants.map((p) => {
                const initial = p.name.charAt(0).toUpperCase() || "P";
                return (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 px-1.5 py-1 rounded-md hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="relative shrink-0">
                        <div className="size-6 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-[10px] font-semibold text-zinc-700 dark:text-zinc-300">
                          {initial}
                        </div>
                        <span
                          role="img"
                          aria-label={p.online ? "Online" : "Offline"}
                          className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${
                            p.online ? "bg-emerald-500" : "bg-zinc-400"
                          }`}
                        />
                      </div>
                      <span className="text-[12px] font-medium text-[#0a0a0a] dark:text-zinc-200 truncate">
                        {p.name}
                        {p.isSelf ? " (you)" : ""}
                      </span>
                    </div>
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-[#f4f4f5] dark:bg-zinc-800 text-[#71717a] dark:text-zinc-400">
                      {p.role}
                    </span>
                  </li>
                );
              })}
            </ul>

            {showAddPeople ? (
              <div className="pt-2 border-t border-[#e4e4e7] dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => {
                    setIsPeopleOpen(false);
                    onAddPeople?.();
                  }}
                  className="w-full h-8 px-2.5 rounded-lg flex items-center justify-center gap-1.5 text-[12px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] dark:bg-zinc-800 dark:hover:bg-zinc-700 text-[#0a0a0a] dark:text-zinc-100 transition-colors"
                >
                  <UserPlus className="size-3.5" strokeWidth={1.75} />
                  <span>Add people</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* "…" More Menu Button */}
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => {
            setIsMenuOpen(!isMenuOpen);
            setIsPeopleOpen(false);
          }}
          aria-label="More actions"
          aria-expanded={isMenuOpen}
          className={`size-7 rounded-md flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 ${
            isMenuOpen
              ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100"
              : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60"
          }`}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </button>

        {/* Dropdown Menu */}
        {isMenuOpen ? (
          <div
            role="menu"
            aria-label="Thread actions"
            className="absolute right-0 top-full mt-1.5 w-44 rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-[#18181b] p-1 shadow-lg z-50 animate-in fade-in-50 zoom-in-95 duration-100"
          >
            {/* Share link action */}
            <button
              type="button"
              role="menuitem"
              onClick={handleShare}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] rounded-lg text-[#0a0a0a] dark:text-zinc-200 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/70 transition-colors"
            >
              <Share2 className="size-3.5 text-[#71717a] dark:text-zinc-400 shrink-0" />
              <span>Share link</span>
            </button>

            {/* Rename action (supported by Shiba web-sessions) */}
            {onRename ? (
              <button
                type="button"
                role="menuitem"
                onClick={handleRename}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] rounded-lg text-[#0a0a0a] dark:text-zinc-200 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/70 transition-colors"
              >
                <Edit2 className="size-3.5 text-[#71717a] dark:text-zinc-400 shrink-0" />
                <span>Rename</span>
              </button>
            ) : null}

            {/* Clear messages action */}
            {onClear ? (
              <button
                type="button"
                role="menuitem"
                onClick={handleClear}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] rounded-lg text-[#0a0a0a] dark:text-zinc-200 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/70 transition-colors"
              >
                <Trash2 className="size-3.5 text-[#71717a] dark:text-zinc-400 shrink-0" />
                <span>Clear chat</span>
              </button>
            ) : null}

            {/* Archive / Delete action */}
            {onArchive ? (
              <div className="pt-1 mt-1 border-t border-[#e4e4e7] dark:border-zinc-800">
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleArchive}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                >
                  <Archive className="size-3.5 shrink-0" />
                  <span>Archive thread</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
