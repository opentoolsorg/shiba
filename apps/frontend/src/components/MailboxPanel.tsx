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
 *   - Lists registered mailboxes from Cloudflare Durable Objects.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
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
import type { InboxDraft, InboxEmail, InboxMailbox } from "../types";
import {
  ContextPanel,
  PanelGroup,
  PanelIconButton,
  PanelNavItem,
  type Scope,
} from "./ui/ContextPanel";

export type MailboxFolder = "inbox" | "unread" | "sent" | "drafts" | "queued";

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

async function apiJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

export function MailboxPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  counts: externalCounts,
  mailboxes: externalMailboxes,
  selectedMailbox = "",
  onSelectMailbox,
  onCompose,
  onSearch,
  onOpenSettings,
  className = "",
}: MailboxPanelProps): JSX.Element {
  const [internalMailboxes, setInternalMailboxes] = useState<InboxMailbox[]>([]);
  const [internalCounts, setInternalCounts] = useState<MailboxCounts>({
    inbox: 0,
    unread: 0,
    sent: 0,
    drafts: 0,
    queued: 0,
  });

  const mailboxes = externalMailboxes ?? internalMailboxes;
  const counts: MailboxCounts = {
    inbox: externalCounts?.inbox ?? internalCounts.inbox,
    unread: externalCounts?.unread ?? internalCounts.unread,
    sent: externalCounts?.sent ?? internalCounts.sent,
    drafts: externalCounts?.drafts ?? internalCounts.drafts,
    queued: externalCounts?.queued ?? internalCounts.queued,
  };

  const loadData = useCallback(async () => {
    try {
      const [mailboxesRes, emailsRes, draftsRes] = await Promise.all([
        apiJson<{ mailboxes?: InboxMailbox[] }>("/api/mailboxes").catch(() => ({ mailboxes: [] })),
        apiJson<{ emails?: InboxEmail[] }>("/api/emails?limit=50").catch(() => ({ emails: [] })),
        apiJson<{ drafts?: InboxDraft[] }>("/api/drafts?limit=50").catch(() => ({ drafts: [] })),
      ]);

      const mbs = Array.isArray(mailboxesRes.mailboxes) ? mailboxesRes.mailboxes : [];
      const ems = Array.isArray(emailsRes.emails) ? emailsRes.emails : [];
      const drs = Array.isArray(draftsRes.drafts) ? draftsRes.drafts : [];

      setInternalMailboxes(mbs);
      setInternalCounts({
        inbox: ems.length,
        unread: ems.filter((e) => e.status === "unread").length,
        sent: ems.filter((e) => e.direction === "outbound" || e.status === "sent").length,
        drafts: drs.filter((d) => d.status === "draft").length,
        queued: drs.filter((d) => d.status === "queued").length,
      });
    } catch {
      // Fallback silently if unauthenticated or offline
    }
  }, []);

  useEffect(() => {
    if (!externalCounts || !externalMailboxes) {
      void loadData();
    }
  }, [externalCounts, externalMailboxes, loadData]);

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
