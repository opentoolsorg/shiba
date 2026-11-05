/**
 * InboxTab — MainCard view for Mailbox / Email:
 * Registered mailboxes, their mail threads, and drafts awaiting a send decision.
 *
 * Restyled inside MainCard with a 48px header row, breadcrumb:
 * "Scope > Mailbox > <Folder>", empty states, and approval-gated sends.
 * Can be controlled via `activeFolder`/`onSelectFolder` or run standalone.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  FileEdit,
  Inbox,
  Mail,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  InboxAttachment,
  InboxDraft,
  InboxEmail,
  InboxMailbox,
  InboxThread,
} from "../types";
import { formatTimeAgo } from "../ui-helpers";
import {
  EmptyState,
  MainCard,
  type Scope,
} from "./ui/ContextPanel";

const GHOST_BUTTON =
  "text-[12px] bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-[#e4e4e7] dark:border-zinc-800 text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 font-medium py-1.5 px-3 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5";
const ACCENT_BUTTON =
  "text-[12px] bg-[#0a0a0a] hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-medium py-1.5 px-3 rounded-lg transition-colors shadow-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed";
const SECONDARY_BUTTON =
  "text-[12px] bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-transparent text-[#0a0a0a] dark:text-zinc-100 font-medium py-1.5 px-3 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-50";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

/** Email statuses mapped to the warm dashboard palette. */
function emailChipClass(status: string): string {
  switch (status) {
    case "unread":
      return "text-blue-700 border-blue-300 bg-blue-50 dark:text-blue-400 dark:border-blue-900 dark:bg-blue-950/60 font-semibold";
    case "sent":
      return "text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900 dark:bg-emerald-950/60";
    case "deleted":
      return "text-rose-700 border-rose-300 bg-rose-50 dark:text-rose-400 dark:border-rose-900 dark:bg-rose-950/60";
    default:
      return "text-[#71717a] border-[#e4e4e7] bg-white dark:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900";
  }
}

function draftChipClass(status: string): string {
  switch (status) {
    case "draft":
      return "text-amber-800 border-amber-300 bg-amber-50 dark:text-amber-300 dark:border-amber-900 dark:bg-amber-950/60";
    case "queued":
      return "text-blue-700 border-blue-300 bg-blue-50 dark:text-blue-400 dark:border-blue-900 dark:bg-blue-950/60";
    case "sent":
      return "text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900 dark:bg-emerald-950/60";
    default:
      return "text-[#71717a] border-[#e4e4e7] bg-white dark:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900";
  }
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where a reply to this email goes: inbound mail answers its sender. */
export function replyAddress(email: InboxEmail): string {
  return email.direction === "inbound" ? email.from_addr : email.to_addr;
}

/**
 * Mailbox a reply draft should be attributed to. The detail route returns
 * the owning mailbox at top level (`StoredEmail` carries none); the row's
 * `mailbox` tag only exists on fan-out list responses, so the "All
 * mailboxes" view must not rely on it.
 */
export function replyMailbox(
  detail: { mailbox: string | null; email: InboxEmail } | null,
  mailboxFilter: string,
): string {
  return detail?.mailbox ?? detail?.email.mailbox ?? mailboxFilter;
}

function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export interface InboxTabProps {
  /** Jumps to the Approvals tab so a queued send is one click away. */
  onOpenApprovals?: () => void;
  activeFolder?: string;
  onSelectFolder?: (folder: string) => void;
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  mailboxFilter?: string;
  onSelectMailbox?: (mailbox: string) => void;
  onCountsChange?: (counts: { inbox: number; unread: number; sent: number; drafts: number; queued: number }) => void;
  onMailboxesChange?: (mailboxes: InboxMailbox[]) => void;
  className?: string;
}

export function InboxTab({
  onOpenApprovals,
  activeFolder: externalFolder,
  onSelectFolder,
  scope = "personal",
  mailboxFilter: externalMailbox,
  onSelectMailbox,
  onCountsChange,
  onMailboxesChange,
  className = "",
}: InboxTabProps): JSX.Element {
  const [internalFolder, setInternalFolder] = useState<string>("inbox");
  const folder = externalFolder ?? internalFolder;
  const setFolder = onSelectFolder ?? setInternalFolder;

  const [mailboxes, setMailboxes] = useState<InboxMailbox[] | null>(null);
  const [internalMailbox, setInternalMailbox] = useState("");
  const mailbox = externalMailbox ?? internalMailbox;
  const setMailbox = onSelectMailbox ?? setInternalMailbox;

  const [emails, setEmails] = useState<InboxEmail[]>([]);
  const [drafts, setDrafts] = useState<InboxDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ mailbox: string | null; email: InboxEmail; attachments: InboxAttachment[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Settings & Two-Step Pairing State
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairingStep, setPairingStep] = useState<1 | 2>(1);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newAgent, setNewAgent] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerNotice, setRegisterNotice] = useState<string | null>(null);

  const detailRequestRef = useRef<string | null>(null);

  const loadMailboxes = useCallback(async () => {
    try {
      const body = await apiJson<{ mailboxes?: InboxMailbox[] }>("/api/mailboxes");
      const list = Array.isArray(body.mailboxes) ? body.mailboxes : [];
      setMailboxes(list);
      onMailboxesChange?.(list);
    } catch {
      setMailboxes((current) => current ?? []);
    }
  }, [onMailboxesChange]);

  useEffect(() => {
    void loadMailboxes();
  }, [loadMailboxes]);

  const loadMail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mailboxParam = mailbox === "" ? "" : `mailbox=${encodeURIComponent(mailbox)}&`;
      const [emailsBody, draftsBody] = await Promise.all([
        apiJson<{ emails?: InboxEmail[] }>(`/api/emails?${mailboxParam}limit=50`),
        apiJson<{ drafts?: InboxDraft[] }>(`/api/drafts?${mailboxParam}limit=50`),
      ]);
      const ems = Array.isArray(emailsBody.emails) ? emailsBody.emails : [];
      const drs = Array.isArray(draftsBody.drafts) ? draftsBody.drafts : [];
      setEmails(ems);
      setDrafts(drs);

      onCountsChange?.({
        inbox: ems.length,
        unread: ems.filter((e) => e.status === "unread").length,
        sent: ems.filter((e) => e.direction === "outbound" || e.status === "sent").length,
        drafts: drs.filter((d) => d.status === "draft").length,
        queued: drs.filter((d) => d.status === "queued").length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mailbox, onCountsChange]);

  useEffect(() => {
    void loadMail();
  }, [loadMail]);

  const runSearch = useCallback(async () => {
    const q = search.trim();
    if (q === "") {
      void loadMail();
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const mailboxParam = mailbox === "" ? "" : `&mailbox=${encodeURIComponent(mailbox)}`;
      const body = await apiJson<{ emails?: InboxEmail[] }>(
        `/api/emails-search?q=${encodeURIComponent(q)}${mailboxParam}&limit=50`,
      );
      setEmails(Array.isArray(body.emails) ? body.emails : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [search, mailbox, loadMail]);

  const registerMailbox = useCallback(async () => {
    const address = newAddress.trim();
    if (address === "") {
      setRegisterError("Enter the mailbox address to register.");
      return;
    }
    setActionBusy("register");
    setRegisterError(null);
    setRegisterNotice(null);
    try {
      const label = newLabel.trim();
      const agent = newAgent.trim();
      if (agent !== "" && (agent.length > 128 || /\s/.test(agent))) {
        setRegisterError("Agent principal must match the token name (no whitespace, max 128 characters).");
        return;
      }
      const result = await apiJson<{ mailbox?: InboxMailbox }>("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, ...(label === "" ? {} : { label }), agent: agent || null }),
      });
      const assigned = result.mailbox?.agent;
      setRegisterNotice(assigned
        ? `Registered ${address} for agent ${assigned}. Configure Email Routing and test delivery before using it.`
        : `Registered ${address} for dashboard use. Configure Email Routing and test delivery before using it.`);
      setNewAddress("");
      setNewLabel("");
      setNewAgent("");
      setPairingStep(1);
      setSettingsOpen(false);
      await loadMailboxes();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [newAddress, newLabel, newAgent, loadMailboxes]);

  const toggleExpanded = useCallback(
    async (email: InboxEmail) => {
      if (expandedId === email.id) {
        detailRequestRef.current = null;
        setExpandedId(null);
        setDetail(null);
        setThread(null);
        setReplyOpen(false);
        return;
      }
      detailRequestRef.current = email.id;
      setExpandedId(email.id);
      setDetail(null);
      setThread(null);
      setReplyOpen(false);
      setReplyBody("");
      setDetailLoading(true);
      try {
        const body = await apiJson<{ mailbox?: string; email: InboxEmail; attachments?: InboxAttachment[] }>(
          `/api/emails/${encodeURIComponent(email.id)}`,
        );
        if (detailRequestRef.current !== email.id) return;
        setDetail({ mailbox: body.mailbox ?? null, email: body.email ?? email, attachments: body.attachments ?? [] });
        if (email.status === "unread") {
          setEmails((prev) =>
            prev.map((row) => (row.id === email.id ? { ...row, status: "read" } : row)),
          );
          apiJson(`/api/emails/${encodeURIComponent(email.id)}/read`, { method: "POST" }).catch(
            () => {},
          );
        }
      } catch (err) {
        if (detailRequestRef.current === email.id) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (detailRequestRef.current === email.id) {
          setDetailLoading(false);
        }
      }
    },
    [expandedId],
  );

  const toggleThread = useCallback(async () => {
    if (thread !== null) {
      setThread(null);
      return;
    }
    if (detail === null || !detail.email.thread_id) return;
    const detailFor = detail.email.id;
    setThreadLoading(true);
    try {
      const body = await apiJson<{ thread: InboxThread }>(
        `/api/threads/${encodeURIComponent(detail.email.thread_id)}`,
      );
      if (detailRequestRef.current === detailFor) {
        setThread(body.thread);
      }
    } catch (err) {
      if (detailRequestRef.current === detailFor) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setThreadLoading(false);
    }
  }, [thread, detail]);

  const saveReply = useCallback(async () => {
    if (detail === null || replyBody.trim() === "") return;
    const mailboxAddress = replyMailbox(detail, mailbox);
    if (mailboxAddress === "") {
      setError("Pick a mailbox in the filter to reply from.");
      return;
    }
    setActionBusy("reply");
    setError(null);
    try {
      await apiJson("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: mailboxAddress,
          to_addr: replyAddress(detail.email),
          subject: replySubject(detail.email.subject),
          body_text: replyBody,
          thread_id: detail.email.thread_id,
          in_reply_to_email_id: detail.email.id,
        }),
      });
      setNotice("Reply saved to drafts. It will require approval before sending.");
      setReplyOpen(false);
      setReplyBody("");
      await loadMail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [detail, mailbox, replyBody, loadMail]);

  const sendDraft = useCallback(
    async (draft: InboxDraft) => {
      setActionBusy(draft.id);
      setError(null);
      try {
        await apiJson(`/api/drafts/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
        setNotice("Draft locked & queued for human approval — review it in the Approvals tab.");
        setDrafts((prev) =>
          prev.map((row) => (row.id === draft.id ? { ...row, status: "queued" } : row)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionBusy(null);
      }
    },
    [],
  );

  // Computed metrics
  const unreadCount = useMemo(() => emails.filter((e) => e.status === "unread").length, [emails]);
  const queuedDraftsCount = useMemo(() => drafts.filter((d) => d.status === "queued").length, [drafts]);

  // Filtered emails based on folder
  const displayedEmails = useMemo(() => {
    if (folder === "unread") {
      return emails.filter((e) => e.status === "unread");
    }
    if (folder === "sent") {
      return emails.filter((e) => e.direction === "outbound" || e.status === "sent");
    }
    return emails;
  }, [emails, folder]);

  const displayedDrafts = useMemo(() => {
    if (folder === "queued") {
      return drafts.filter((d) => d.status === "queued");
    }
    if (folder === "drafts") {
      return drafts.filter((d) => d.status === "draft");
    }
    return drafts;
  }, [drafts, folder]);

  // Breadcrumb folder title
  const folderTitle = useMemo(() => {
    switch (folder) {
      case "unread":
        return "Unread";
      case "sent":
        return "Sent";
      case "drafts":
        return "Drafts";
      case "queued":
        return "Queued for approval";
      default:
        return "Inbox";
    }
  }, [folder]);

  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";
  const countLabel = folder === "drafts" || folder === "queued"
    ? `${displayedDrafts.length} ${displayedDrafts.length === 1 ? "draft" : "drafts"}`
    : `${displayedEmails.length} ${displayedEmails.length === 1 ? "message" : "messages"}`;

  return (
    <MainCard className={className}>
      {/* 48px Header row with breadcrumb */}
      <header className="h-12 min-h-[48px] w-full px-4 border-b border-[#e4e4e7] dark:border-zinc-800 flex items-center justify-between select-none shrink-0 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-2 min-w-0">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
            <ol className="flex items-center gap-1.5 min-w-0">
              <li className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">{scopeLabel}</li>
              <ChevronRight className="size-3.5 text-[#a1a1aa] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <li className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">Mailbox</li>
              <ChevronRight className="size-3.5 text-[#a1a1aa] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <li className="text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate" aria-current="page">
                {folderTitle}
              </li>
            </ol>
            <span className="text-[12px] text-[#71717a] dark:text-zinc-400 select-none shrink-0 font-normal ml-2" role="status">
              {countLabel}
            </span>
          </nav>
        </div>

        {/* Right header actions */}
        <div className="flex items-center gap-2 shrink-0">
          {searchOpen ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search mail…"
                aria-label="Search mail"
                // biome-ignore lint/a11y/noAutofocus: field is revealed by an explicit user action
                autoFocus
                className="h-8 w-48 sm:w-64 rounded-md border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-800 px-2.5 text-[12px] text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
              <button type="submit" disabled={searching} className={ACCENT_BUTTON}>
                Search
              </button>
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearch("");
                  void loadMail();
                }}
                className="size-8 flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100"
                aria-label="Close search"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Search mail"
              className="size-8 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] hover:bg-[#f4f4f5] dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={() => void loadMail()}
            disabled={loading}
            aria-label="Refresh mailbox"
            title="Refresh mailbox"
            className="size-8 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] hover:bg-[#f4f4f5] dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => setSettingsOpen((prev) => !prev)}
            aria-expanded={settingsOpen}
            aria-label="Mailbox settings"
            title="Configure mailboxes"
            className="h-8 px-2.5 rounded-lg border border-[#e4e4e7] dark:border-zinc-800 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 text-[12px] font-medium text-[#0a0a0a] dark:text-zinc-100 flex items-center gap-1.5 transition-colors"
          >
            <Settings className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden sm:inline">Settings</span>
          </button>

          {queuedDraftsCount > 0 ? (
            <button
              type="button"
              onClick={onOpenApprovals}
              aria-label="View queued approvals"
              className="h-8 px-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-[12px] font-medium flex items-center gap-1.5 transition-colors shadow-xs"
            >
              <Clock className="size-3.5" strokeWidth={2} aria-hidden="true" />
              <span>{queuedDraftsCount} Queued</span>
            </button>
          ) : null}
        </div>
      </header>

      {/* Main card body scroll area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col gap-4">
        {/* Global Notices / Errors */}
        {notice !== null ? (
          <div
            role="status"
            className="text-[12px] text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-900 rounded-xl p-3 flex items-center justify-between gap-3 shadow-xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="size-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="font-medium truncate">{notice}</span>
            </div>
            <button
              type="button"
              className="text-emerald-700 dark:text-emerald-400 font-medium hover:underline shrink-0 text-xs inline-flex items-center gap-1"
              onClick={onOpenApprovals}
            >
              Approvals Queue →
            </button>
          </div>
        ) : null}

        {error !== null ? (
          <div
            role="alert"
            className="text-[12px] text-rose-800 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900 rounded-xl p-3 flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="size-4 shrink-0 text-rose-500" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-rose-600 dark:text-rose-400 hover:opacity-75 font-medium text-xs"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Mailbox Configuration Drawer / Inline Section */}
        {settingsOpen ? (
          <section
            aria-label="Agent Mailbox Configuration"
            className="border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-[#fafafa] dark:bg-zinc-800/50 p-4 flex flex-col gap-3 shadow-xs"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-[13px] font-semibold text-[#0a0a0a] dark:text-zinc-100">
                  Mailbox Configuration &amp; Pairing
                </h4>
                <p className="text-[12px] text-[#71717a] dark:text-zinc-400 mt-0.5 max-w-xl">
                  Connect inbound routing addresses to isolated Mailbox Durable Objects. All outbound communications require human verification via the Approvals queue. No provider credentials exist inside execution sandboxes.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors"
                aria-label="Close settings"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Currently Configured Mailboxes */}
            <div className="bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg p-3">
              <h5 className="text-[11px] font-mono uppercase tracking-wider text-[#71717a] dark:text-zinc-400 mb-2">
                Active Mailbox Lines
              </h5>
              {mailboxes === null || mailboxes.length === 0 ? (
                <p className="text-[12px] text-[#71717a] dark:text-zinc-500 italic">No mailboxes registered yet.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {mailboxes.map((mb) => (
                    <div
                      key={mb.address}
                      className="flex items-center justify-between gap-2 text-[12px] bg-[#fafafa] dark:bg-zinc-800 border border-[#e4e4e7] dark:border-zinc-700/60 rounded-md px-2.5 py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="size-2 rounded-full bg-emerald-500" />
                        <span className="font-mono font-medium text-[#0a0a0a] dark:text-zinc-100 truncate">{mb.address}</span>
                        {mb.label ? (
                          <span className="text-[10px] text-[#71717a] dark:text-zinc-400 bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-700 rounded px-1.5 py-0.2">
                            {mb.label}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400 shrink-0">
                        {mb.agent ? `agent: ${mb.agent}` : "dashboard only"} · registered {formatTimeAgo(mb.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Two-Step Pairing Form */}
            <div className="border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 rounded-lg p-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono uppercase font-bold tracking-wider text-blue-700 dark:text-blue-400">
                  {pairingStep === 1 ? "Step 1: Define Mailbox Identity" : "Step 2: Security & Privacy Verification"}
                </span>
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#71717a] dark:text-zinc-400">
                  <span className={`size-2 rounded-full ${pairingStep === 1 ? "bg-blue-600 dark:bg-blue-400" : "bg-emerald-500"}`} />
                  <span>Step {pairingStep} of 2</span>
                </div>
              </div>

              {pairingStep === 1 ? (
                <div className="flex flex-col gap-2.5">
                  <p className="text-[12px] text-[#0a0a0a] dark:text-zinc-200">
                    Register the address for this mailbox. Incoming mail is stored only after Cloudflare Email Routing is configured to deliver it to this Worker.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400 block mb-1">
                        Mailbox Address *
                      </label>
                      <input
                        type="email"
                        required
                        value={newAddress}
                        onChange={(e) => setNewAddress(e.target.value)}
                        placeholder="agent@shiba.dev"
                        aria-label="Mailbox address"
                        className="w-full text-[12px] font-mono bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg px-2.5 py-1.5 text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-zinc-400"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400 block mb-1">
                        Display label (optional)
                      </label>
                      <input
                        type="text"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        placeholder="e.g. Primary Assistant"
                        aria-label="Mailbox label"
                        className="w-full text-[12px] bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg px-2.5 py-1.5 text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-zinc-400"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400 block mb-1">
                        Cloud agent token principal (optional)
                      </label>
                      <input
                        type="text"
                        value={newAgent}
                        onChange={(e) => setNewAgent(e.target.value)}
                        maxLength={128}
                        placeholder="e.g. claude-code (from mint-token --agent)"
                        aria-label="Cloud agent token principal"
                        className="w-full text-[12px] font-mono bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg px-2.5 py-1.5 text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-zinc-400"
                      />
                      <p className="text-[11px] text-[#71717a] dark:text-zinc-500 mt-1">Leave blank for dashboard-only mail. Re-enter an existing address to assign or change its agent.</p>
                    </div>
                  </div>

                  {registerError !== null ? (
                    <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-400 font-medium">
                      {registerError}
                    </p>
                  ) : null}

                  <div className="flex justify-end gap-2 mt-1">
                    <button
                      type="button"
                      className={ACCENT_BUTTON}
                      disabled={newAddress.trim() === ""}
                      onClick={() => {
                        if (newAddress.trim() === "") {
                          setRegisterError("Please enter an email address.");
                          return;
                        }
                        setRegisterError(null);
                        setPairingStep(2);
                      }}
                    >
                      Next: Review Policies →
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  <div className="bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg p-3 text-[12px] text-[#0a0a0a] dark:text-zinc-100 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">Selected Address:</span>
                      <span className="font-mono text-blue-600 dark:text-blue-400">{newAddress}</span>
                      {newLabel ? <span className="text-[#71717a] dark:text-zinc-400">({newLabel})</span> : null}
                    </div>
                    <div>Cloud agent: <span className="font-mono">{newAgent.trim() || "dashboard only"}</span></div>
                    <div className="text-[11px] text-[#71717a] dark:text-zinc-400 space-y-1 mt-1 border-t border-[#e4e4e7] dark:border-zinc-800 pt-1.5">
                      <p>✓ <strong>Approval-Gated Outbound:</strong> Every draft created by agents requires explicit human sign-off prior to external delivery.</p>
                      <p>✓ <strong>Zero Sandbox Secrets:</strong> Sandboxes cannot access provider credentials or SMTP servers directly.</p>
                      <p>✓ <strong>Isolated Storage:</strong> State is sealed in Cloudflare Durable Objects under sovereign tenancy.</p>
                    </div>
                  </div>

                  {registerError !== null ? (
                    <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-400 font-medium">
                      {registerError}
                    </p>
                  ) : null}

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className={GHOST_BUTTON}
                      onClick={() => setPairingStep(1)}
                    >
                      ← Back
                    </button>
                    <button
                      type="button"
                      className={ACCENT_BUTTON}
                      disabled={actionBusy === "register"}
                      onClick={() => void registerMailbox()}
                    >
                      {actionBusy === "register" ? "Registering…" : "Register Mailbox"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {registerNotice !== null ? (
          <p role="status" className="text-[12px] text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-900 rounded-xl px-3 py-2">
            {registerNotice}
          </p>
        ) : null}

        {/* First mailbox guidance when no mailboxes are registered */}
        {mailboxes !== null && mailboxes.length === 0 ? (
          <details className="border border-blue-200 dark:border-blue-900/60 bg-blue-50/40 dark:bg-blue-950/20 p-3.5 rounded-xl text-xs text-[#0a0a0a] dark:text-zinc-200">
            <summary className="cursor-pointer font-semibold">First mailbox: from setup to a received message</summary>
            <ol className="mt-2 ml-4 list-decimal space-y-1.5 text-[#71717a] dark:text-zinc-400">
              <li><button type="button" onClick={() => setSettingsOpen(true)} className="text-blue-600 dark:text-blue-400 hover:underline">Register a mailbox</button> and assign the exact MCP token principal.</li>
              <li><a href="/docs/api/#email-api" className="text-blue-600 dark:text-blue-400 hover:underline">Configure Cloudflare Email Routing</a> for that address to this Worker. Registration does not configure routing.</li>
              <li><a href="/?tab=agents" className="text-blue-600 dark:text-blue-400 hover:underline">Mint and connect an agent token</a> with <code>email:read</code> (and draft/send scopes only if needed).</li>
              <li>Send a test email from another address; confirm it appears here and the agent&apos;s <code>list_emails</code> can see it.</li>
            </ol>
          </details>
        ) : null}

        {/* Fallback filter switcher if operated standalone (no externalFolder passed) */}
        {externalFolder === undefined ? (
          <div className="flex items-center gap-1 bg-[#f4f4f5] dark:bg-zinc-800/80 p-1 rounded-lg w-fit">
            {(["inbox", "unread", "sent", "drafts", "queued"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFolder(key)}
                className={`text-[12px] font-medium px-3 py-1 rounded-md transition-all ${
                  folder === key
                    ? "bg-white text-[#0a0a0a] shadow-xs dark:bg-zinc-900 dark:text-zinc-100"
                    : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </button>
            ))}
          </div>
        ) : null}

        {/* Sacred Approval Boundary Outbound Section (Drafts & Queued Sends) */}
        {(folder === "drafts" || folder === "queued" || (folder === "inbox" && queuedDraftsCount > 0) || folder === "all") && displayedDrafts.length > 0 ? (
          <section
            aria-label="Drafts requiring human approval"
            className="border-2 border-amber-400/80 dark:border-amber-600/80 rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-sm flex flex-col gap-3"
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="size-5 text-amber-600 dark:text-amber-400" />
                <div>
                  <h3 className="text-[12px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                    Approval Boundary: Outbound Transmissions
                  </h3>
                  <p className="text-[12px] text-[#71717a] dark:text-zinc-400">
                    All outbound emails created by agents must be confirmed by a human operator before delivery.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenApprovals}
                className="text-[12px] text-blue-600 dark:text-blue-400 hover:underline font-medium ml-auto"
              >
                Open Approvals Queue →
              </button>
            </div>

            <div className="flex flex-col gap-2.5">
              {displayedDrafts.map((draft) => {
                const isQueued = draft.status === "queued";
                return (
                  <article
                    key={draft.id}
                    className={`border rounded-lg bg-[#fafafa] dark:bg-zinc-800/60 p-3.5 transition-colors ${
                      isQueued
                        ? "border-blue-300 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/20"
                        : "border-[#e4e4e7] dark:border-zinc-700/60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-[#71717a] dark:text-zinc-400">To:</span>
                          <span className="font-mono text-[12px] text-[#0a0a0a] dark:text-zinc-100 font-medium truncate">
                            {draft.to_addr}
                          </span>
                          {draft.mailbox ? (
                            <span className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400 bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-700 rounded px-1.5">
                              via {draft.mailbox}
                            </span>
                          ) : null}
                        </div>
                        <h4 className="text-[13px] font-semibold text-[#0a0a0a] dark:text-zinc-100 mt-0.5 truncate">
                          {draft.subject}
                        </h4>
                      </div>

                      <span
                        className={`text-[10px] font-mono uppercase font-bold tracking-wider border rounded-md px-2 py-0.5 shrink-0 ${draftChipClass(
                          draft.status,
                        )}`}
                      >
                        {draft.status === "queued" ? "Queued for Approval" : draft.status}
                      </span>
                    </div>

                    <p className="text-[12px] text-[#0a0a0a] dark:text-zinc-200 font-mono whitespace-pre-wrap bg-white dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg p-3 mb-3 max-h-36 overflow-auto">
                      {draft.body_text}
                    </p>

                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <span className="text-[11px] text-[#71717a] dark:text-zinc-400 font-mono">
                        Last edited {formatTimeAgo(draft.updated_at)}
                      </span>

                      {draft.status === "draft" ? (
                        <button
                          type="button"
                          className={ACCENT_BUTTON}
                          disabled={actionBusy === draft.id}
                          onClick={() => void sendDraft(draft)}
                        >
                          {actionBusy === draft.id ? "Submitting to Queue…" : "Send for approval →"}
                        </button>
                      ) : isQueued ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                            <span className="size-2 rounded-full bg-blue-500 animate-pulse" />
                            Pending Human Decision
                          </span>
                          <button
                            type="button"
                            className={SECONDARY_BUTTON}
                            onClick={onOpenApprovals}
                          >
                            Review in Approvals tab
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Empty state when viewing drafts or queued and none exist */}
        {(folder === "drafts" || folder === "queued") && displayedDrafts.length === 0 ? (
          <EmptyState
            icon={folder === "queued" ? ShieldCheck : FileEdit}
            title={folder === "queued" ? "No queued approvals" : "No drafts"}
            description={
              folder === "queued"
                ? "Outbound emails requiring human approval before dispatch will appear here."
                : "Draft responses and outbound agent communications will appear here."
            }
          />
        ) : null}

        {/* Main Mail List / Feed */}
        {folder !== "drafts" && folder !== "queued" ? (
          <section aria-label="Inbox messages" className="flex flex-col gap-2">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12 border border-dashed border-[#e4e4e7] dark:border-zinc-800 rounded-xl px-4 text-center">
                <div className="size-6 border-2 border-zinc-400 border-t-zinc-900 dark:border-t-zinc-100 rounded-full animate-spin mb-2" />
                <p className="text-[#71717a] dark:text-zinc-400 text-xs font-mono">Loading mail…</p>
              </div>
            ) : displayedEmails.length === 0 ? (
              search.trim() !== "" ? (
                <EmptyState
                  icon={Search}
                  title="No matching mail"
                  description={`No messages matching "${search}".`}
                  action={
                    <button
                      type="button"
                      className={GHOST_BUTTON}
                      onClick={() => {
                        setSearch("");
                        void loadMail();
                      }}
                    >
                      Clear search
                    </button>
                  }
                />
              ) : folder === "unread" ? (
                <EmptyState
                  icon={Mail}
                  title="No unread mail"
                  description="You're all caught up. New incoming mail will show up here."
                />
              ) : folder === "sent" ? (
                <EmptyState
                  icon={Send}
                  title="No sent mail"
                  description="Outbound messages will appear here after approval and delivery."
                />
              ) : mailboxes !== null && mailboxes.length === 0 ? (
                <EmptyState
                  icon={Inbox}
                  title="No mailboxes registered yet"
                  description="Register a mailbox line so Cloudflare Email Routing can deliver agent correspondence."
                  action={
                    <button
                      type="button"
                      className={ACCENT_BUTTON}
                      onClick={() => setSettingsOpen(true)}
                    >
                      Register Mailbox Line
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  icon={Inbox}
                  title="No mail found"
                  description="Emails delivered to your paired addresses will show up here."
                />
              )
            ) : (
              <ol className="flex flex-col gap-2">
                {displayedEmails.map((email) => {
                  const expanded = expandedId === email.id;
                  const isUnread = email.status === "unread";
                  const isInbound = email.direction === "inbound";

                  return (
                    <li
                      key={email.id}
                      className={`border rounded-xl bg-white dark:bg-zinc-900 overflow-hidden transition-all shadow-xs ${
                        expanded
                          ? "border-blue-500 ring-1 ring-blue-500/20"
                          : "border-[#e4e4e7] dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                      }`}
                    >
                      {/* Collapsed / Row Summary Button */}
                      <button
                        type="button"
                        onClick={() => void toggleExpanded(email)}
                        aria-expanded={expanded}
                        className="w-full text-left p-3.5 hover:bg-[#fafafa] dark:hover:bg-zinc-800/50 transition-colors flex flex-col gap-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`size-2 rounded-full shrink-0 ${
                              isUnread ? "bg-blue-600 ring-4 ring-blue-500/20" : "bg-transparent"
                            }`}
                            title={isUnread ? "Unread" : "Read"}
                          />

                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.2 rounded border shrink-0 ${
                              isInbound
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-400 dark:border-emerald-900"
                                : "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-900"
                            }`}
                          >
                            {isInbound ? "Inbound" : "Outbound"}
                          </span>

                          <span
                            className={`text-[12px] truncate min-w-0 font-mono ${
                              isUnread ? "text-[#0a0a0a] dark:text-zinc-100 font-bold" : "text-[#71717a] dark:text-zinc-400"
                            }`}
                          >
                            {isInbound ? email.from_addr : `to ${email.to_addr}`}
                          </span>

                          {email.mailbox ? (
                            <span className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400 border border-[#e4e4e7] dark:border-zinc-800 rounded px-1.5 bg-[#fafafa] dark:bg-zinc-800 shrink-0">
                              {email.mailbox}
                            </span>
                          ) : null}

                          <span className="text-[11px] text-[#71717a] dark:text-zinc-400 font-mono shrink-0 ml-auto">
                            {formatTimeAgo(email.created_at)}
                          </span>
                        </div>

                        <h4
                          className={`text-[13px] truncate pl-4 font-medium ${
                            isUnread ? "text-[#0a0a0a] dark:text-zinc-100" : "text-[#71717a] dark:text-zinc-400"
                          }`}
                        >
                          {email.subject || "(no subject)"}
                        </h4>
                      </button>

                      {/* Expanded Detail View */}
                      {expanded ? (
                        <div className="p-4 pt-2 border-t border-[#e4e4e7] dark:border-zinc-800 bg-[#fafafa] dark:bg-zinc-900/60 flex flex-col gap-3">
                          {detailLoading ? (
                            <div className="py-4 flex items-center justify-center gap-2 text-xs font-mono text-[#71717a] dark:text-zinc-400">
                              <span className="size-3 border-2 border-zinc-400 border-t-zinc-900 dark:border-t-zinc-100 rounded-full animate-spin" />
                              Loading message details…
                            </div>
                          ) : detail !== null ? (
                            <>
                              {/* Metadata Header */}
                              <div className="bg-white dark:bg-zinc-800/80 border border-[#e4e4e7] dark:border-zinc-700/60 rounded-lg p-3 text-[12px] text-[#0a0a0a] dark:text-zinc-100 flex flex-col gap-1.5 shadow-2xs">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <div className="space-y-0.5">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] font-mono uppercase text-[#71717a] dark:text-zinc-400">From:</span>
                                      <span className="font-mono font-medium">{detail.email?.from_addr || email.from_addr}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] font-mono uppercase text-[#71717a] dark:text-zinc-400">To:</span>
                                      <span className="font-mono font-medium">{detail.email?.to_addr || email.to_addr}</span>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {email.mailbox ? (
                                      <span className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400 bg-[#fafafa] dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded px-1.5 py-0.5">
                                        Mailbox: {email.mailbox}
                                      </span>
                                    ) : null}
                                    <span className={`text-[10px] font-mono border rounded px-2 py-0.5 ${emailChipClass(detail.email.status)}`}>
                                      {detail.email.status}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Message Body */}
                              <div className="bg-white dark:bg-zinc-800/80 border border-[#e4e4e7] dark:border-zinc-700/60 rounded-lg p-3.5 shadow-2xs">
                                <pre className="font-mono text-[12px] text-[#0a0a0a] dark:text-zinc-100 whitespace-pre-wrap break-words leading-relaxed max-h-72 overflow-auto">
                                  {detail.email.body_text ?? "(no plain-text body)"}
                                </pre>
                              </div>

                              {/* Attachments */}
                              {detail.attachments.length > 0 ? (
                                <div className="flex flex-col gap-1.5">
                                  <span className="text-[10px] font-mono uppercase text-[#71717a] dark:text-zinc-400">Attachments ({detail.attachments.length})</span>
                                  <div className="flex flex-wrap gap-2">
                                    {detail.attachments.map((attachment) => (
                                      <a
                                        key={attachment.part_id}
                                        href={`/api/emails/${encodeURIComponent(detail.email.id)}/attachments/${encodeURIComponent(attachment.part_id)}`}
                                        download={attachment.filename ?? "attachment"}
                                        aria-label={`Download ${attachment.filename ?? attachment.part_id}`}
                                        className="text-[12px] font-mono text-[#0a0a0a] dark:text-zinc-100 border border-[#e4e4e7] dark:border-zinc-700/60 bg-white dark:bg-zinc-800 rounded-lg px-2.5 py-1.5 flex items-center gap-2 shadow-2xs hover:bg-[#fafafa] dark:hover:bg-zinc-700/50 transition-colors"
                                      >
                                        <span>📎</span>
                                        <span className="font-medium">{attachment.filename ?? attachment.part_id}</span>
                                        {attachment.size !== undefined ? (
                                          <span className="text-[10px] text-[#71717a] dark:text-zinc-400">({formatBytes(attachment.size)})</span>
                                        ) : null}
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              ) : null}

                              {/* Action Bar */}
                              <div className="flex items-center gap-2 pt-1 flex-wrap">
                                <button
                                  type="button"
                                  className={GHOST_BUTTON}
                                  onClick={() => void toggleThread()}
                                >
                                  {threadLoading ? "Loading thread…" : thread !== null ? "Hide thread" : "View thread"}
                                </button>
                                <button
                                  type="button"
                                  className={ACCENT_BUTTON}
                                  onClick={() => setReplyOpen((open) => !open)}
                                >
                                  {replyOpen ? "Close reply draft" : "Draft reply"}
                                </button>
                              </div>

                              {/* Thread Timeline */}
                              {thread !== null ? (
                                <div className="border border-[#e4e4e7] dark:border-zinc-700/60 rounded-lg bg-white dark:bg-zinc-800/60 p-3 flex flex-col gap-2 mt-1">
                                  <h5 className="text-[11px] font-mono uppercase tracking-wider text-[#71717a] dark:text-zinc-400">
                                    Thread History ({thread.emails.length} messages)
                                  </h5>
                                  <ol className="flex flex-col gap-2 border-l-2 border-blue-400/50 dark:border-blue-700 pl-3 ml-1">
                                    {thread.emails.map((item) => (
                                      <li key={item.id} className="text-[12px] font-mono">
                                        <div className="flex items-center gap-2 text-[#71717a] dark:text-zinc-400">
                                          <span className="font-medium text-[#0a0a0a] dark:text-zinc-100">{item.from_addr}</span>
                                          <span>·</span>
                                          <span>{formatTimeAgo(item.created_at)}</span>
                                        </div>
                                        <p className="text-[#0a0a0a] dark:text-zinc-200 text-xs mt-0.5">{item.subject}</p>
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                              ) : null}

                              {/* Reply Draft Composer */}
                              {replyOpen ? (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    void saveReply();
                                  }}
                                  className="border-2 border-blue-300 dark:border-blue-800 bg-white dark:bg-zinc-900 rounded-xl p-4 flex flex-col gap-3 shadow-xs"
                                >
                                  <div className="flex items-center justify-between gap-2 border-b border-[#e4e4e7] dark:border-zinc-800 pb-2">
                                    <div className="text-[12px] font-mono">
                                      <span className="text-[#71717a] dark:text-zinc-400">Replying to: </span>
                                      <span className="font-semibold text-[#0a0a0a] dark:text-zinc-100">{replyAddress(detail.email)}</span>
                                      <span className="text-[#71717a] dark:text-zinc-400 ml-2">from </span>
                                      <span className="font-semibold text-blue-600 dark:text-blue-400">{replyMailbox(detail, mailbox) || "(selected mailbox)"}</span>
                                    </div>
                                    <span className="text-[10px] font-mono text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 rounded px-2 py-0.5">
                                      🔒 Approval Gate
                                    </span>
                                  </div>

                                  <div className="text-[11px] text-[#71717a] dark:text-zinc-400">
                                    Subject: <span className="font-mono text-[#0a0a0a] dark:text-zinc-100">{replySubject(detail.email.subject)}</span>
                                  </div>

                                  <textarea
                                    value={replyBody}
                                    onChange={(event) => setReplyBody(event.target.value)}
                                    rows={5}
                                    placeholder="Compose reply message here. Saved drafts require human review before dispatch…"
                                    aria-label="Reply message body"
                                    className="w-full text-xs font-mono bg-[#fafafa] dark:bg-zinc-800 border border-[#e4e4e7] dark:border-zinc-700 rounded-lg p-3 text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-zinc-400"
                                  />

                                  <div className="flex items-center justify-between gap-2 pt-1">
                                    <p className="text-[11px] text-[#71717a] dark:text-zinc-400">
                                      Saving stores this in Drafts. You can then submit it to the Approvals queue.
                                    </p>
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        className={GHOST_BUTTON}
                                        onClick={() => setReplyOpen(false)}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="submit"
                                        className={ACCENT_BUTTON}
                                        disabled={actionBusy === "reply" || replyBody.trim() === ""}
                                      >
                                        {actionBusy === "reply" ? "Saving…" : "Save Draft"}
                                      </button>
                                    </div>
                                  </div>
                                </form>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        ) : null}
      </div>
    </MainCard>
  );
}
