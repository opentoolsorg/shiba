/**
 * MailboxPanel — Secondary contextual panel (~265px) for Mailbox / Email.
 *
 * Header: "Mailbox" (14px/600) + Search action + Compose / New draft action.
 * Scope switch: Personal | Workspace.
 * Folders:
 *   - Inbox (real email count)
 *   - Unread (real unread count)
 *   - Sent (real outbound count)
 *   - Drafts (real drafts count)
 *   - Queued for approval (real queued count)
 * Mailboxes group:
 *   - Lists the mailboxes passed in by the app.
 * The panel never fetches; the app gates the data on private access.
 */
import type { JSX } from "react";
import {
  AtSign,
  Clock,
  FileEdit,
  Inbox,
  Mail,
  Plus,
  Search,
  Send,
  Settings,
} from "lucide-react";
import type { InboxMailbox } from "../types";
import {
  ContextPanel,
  PanelGroup,
  PanelIconButton,
  PanelNavItem,
  type Scope,
} from "./ui/ContextPanel";

export interface MailboxCounts {
  inbox: number;
  unread: number;
  sent: number;
  drafts: number;
  queued: number;
}

export type MailboxPanelItem = Omit<InboxMailbox, "label"> & {
  label?: string | null;
};

export interface MailboxPanelProps {
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  counts?: Partial<MailboxCounts>;
  mailboxes?: MailboxPanelItem[];
  selectedMailbox?: string;
  onSelectMailbox?: (mailbox: string) => void;
  onCompose?: () => void;
  onSearch?: () => void;
  onOpenSettings?: () => void;
  className?: string;
}

export function MailboxPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  counts: providedCounts,
  mailboxes = [],
  selectedMailbox = "",
  onSelectMailbox,
  onCompose,
  onSearch,
  onOpenSettings,
  className = "",
}: MailboxPanelProps): JSX.Element {
  const counts: MailboxCounts = {
    inbox: providedCounts?.inbox ?? 0,
    unread: providedCounts?.unread ?? 0,
    sent: providedCounts?.sent ?? 0,
    drafts: providedCounts?.drafts ?? 0,
    queued: providedCounts?.queued ?? 0,
  };

  const countBadge = (val: number, highlight = false) => (
    <span
      className={`ml-auto font-mono text-[11px] px-1.5 py-0.2 rounded-md ${
        highlight && val > 0
          ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 font-semibold"
          : "text-[#71717a] dark:text-zinc-400"
      }`}
    >
      {val}
    </span>
  );

  return (
    <ContextPanel
      title="Mailbox"
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
      actions={
        <>
          {onSearch ? (
            <PanelIconButton label="Search mailbox" onClick={onSearch}>
              <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </PanelIconButton>
          ) : null}
          {onCompose ? (
            <PanelIconButton label="Compose draft" onClick={onCompose}>
              <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
            </PanelIconButton>
          ) : null}
          {onOpenSettings ? (
            <PanelIconButton label="Mailbox settings" onClick={onOpenSettings}>
              <Settings className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </PanelIconButton>
          ) : null}
        </>
      }
    >
      {/* Folders navigation */}
      <div className="flex flex-col gap-0.5">
        <PanelNavItem
          icon={Inbox}
          label="Inbox"
          active={active === "inbox" || active === "all"}
          onClick={() => onSelect("inbox")}
          trailing={countBadge(counts.inbox)}
        />
        <PanelNavItem
          icon={Mail}
          label="Unread"
          active={active === "unread"}
          onClick={() => onSelect("unread")}
          trailing={countBadge(counts.unread, counts.unread > 0)}
        />
        <PanelNavItem
          icon={Send}
          label="Sent"
          active={active === "sent"}
          onClick={() => onSelect("sent")}
          trailing={countBadge(counts.sent)}
        />
        <PanelNavItem
          icon={FileEdit}
          label="Drafts"
          active={active === "drafts"}
          onClick={() => onSelect("drafts")}
          trailing={countBadge(counts.drafts)}
        />
        <PanelNavItem
          icon={Clock}
          label="Queued for approval"
          active={active === "queued"}
          onClick={() => onSelect("queued")}
          trailing={countBadge(counts.queued, counts.queued > 0)}
        />
      </div>

      {/* Registered Mailboxes */}
      <PanelGroup
        label="Mailboxes"
        emptyText="No mailboxes registered"
        defaultOpen={true}
        action={
          onOpenSettings ? (
            <button
              type="button"
              onClick={onOpenSettings}
              className="text-[11px] text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100"
              aria-label="Manage mailboxes"
            >
              Configure
            </button>
          ) : null
        }
      >
        {mailboxes.map((mb) => {
          const isSelected = selectedMailbox === mb.address;
          return (
            <PanelNavItem
              key={mb.address}
              icon={AtSign}
              label={mb.label || mb.address}
              active={isSelected}
              onClick={() => onSelectMailbox?.(isSelected ? "" : mb.address)}
              trailing={
                mb.agent ? (
                  <span
                    className="font-mono text-[10px] text-[#71717a] dark:text-zinc-400 truncate max-w-[80px]"
                    title={`Agent: ${mb.agent}`}
                  >
                    @{mb.agent}
                  </span>
                ) : null
              }
            />
          );
        })}
      </PanelGroup>
    </ContextPanel>
  );
}
