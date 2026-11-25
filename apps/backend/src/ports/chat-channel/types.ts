/** A tenant-scoped conversation; threadId is the root message, never a reply id. */
export interface ChannelThreadRef {
  channel: string;
  tenantId: string;
  conversationId: string;
  threadId: string;
}

export interface ChannelMessageRef {
  thread: ChannelThreadRef;
  id: string;
}

export interface ChannelApprovalPointer {
  threadKey: string;
  approvalId: string;
}

export type ChannelEvent =
  | { type: "message" | "mention"; id: string; thread: ChannelThreadRef; userId: string; text: string; messageId: string }
  | { type: "action"; thread: ChannelThreadRef; userId: string; action: "approve" | "deny"; approval: ChannelApprovalPointer }
  | { type: "install" | "uninstall"; channel: string; tenantId: string };

export interface ChannelIdentity {
  workspaceId: string;
  userId: string;
  accountId: string;
}

export type ChannelErrorKind = "not_installed" | "not_in_channel" | "rate_limited" | "auth_expired" | "invalid_request";

const messages: Record<ChannelErrorKind, string> = {
  not_installed: "The chat app is not connected. Connect it in Shiba settings.",
  not_in_channel: "The bot is not in this channel. Invite it to the channel and try again.",
  rate_limited: "The chat service is busy. Please try again shortly.",
  auth_expired: "The chat app authorization expired. Reconnect it in Shiba settings.",
  invalid_request: "The chat request could not be completed. Check the request and try again.",
};

export class ChannelError extends Error {
  constructor(readonly kind: ChannelErrorKind, options?: { cause?: unknown; outcomeKnown?: boolean }) {
    super(messages[kind], { cause: options?.cause });
    this.name = "ChannelError";
    this.outcomeKnown = options?.outcomeKnown ?? true;
  }
  readonly outcomeKnown: boolean;
}

export interface ChannelMessageInput {
  thread: ChannelThreadRef;
  text: string;
  /** Optional rich presentation, owned by the adapter composing it. */
  blocks?: unknown[];
  persona?: "lead" | "explorer" | "fixer" | "reviewer";
}

/** Presentation fields already used by the approval domain. A pointer grants no authority. */
export interface ChannelApprovalInput extends ChannelApprovalPointer {
  thread: ChannelThreadRef;
  repoUrl: string;
  task: string;
  workspaceLabel?: string;
  canvasUrl?: string;
  liveCanvas?: boolean;
  publishPullRequest?: boolean;
  kind?: import("../../pending-approvals.js").ApprovalKind;
  employeeLabel?: string;
  agent?: string;
  harness?: string;
  testCommand?: string[];
}

export interface ChatChannel {
  readonly id: string;
  readonly capabilities: Readonly<Record<"threads" | "edits" | "reactions" | "files" | "buttons" | "modals" | "typing" | "streaming", boolean>>;
  /** Neither method consumes the caller's request body. Parse verifies independently. */
  verify(request: Request): Promise<boolean>;
  parse(request: Request): Promise<ChannelEvent[]>;
  postMessage(input: ChannelMessageInput): Promise<ChannelMessageRef>;
  updateMessage(input: { message: ChannelMessageRef; text: string; blocks?: unknown[] }): Promise<void>;
  postApprovalRequest(input: ChannelApprovalInput): Promise<ChannelMessageRef>;
  /** Compatibility for best-effort, unthreaded cards with no delivery receipt. */
  postApprovalNotification(input: Omit<ChannelApprovalInput, "thread"> & { conversationId: string }): Promise<void>;
  /** Updates presentation only; authorization and dispatch remain with the approval domain. */
  resolveApprovalRequest(input: { message: ChannelMessageRef; text: string }): Promise<void>;
  postFile(input: { thread: ChannelThreadRef; name: string; content: Blob }): Promise<ChannelMessageRef>;
  setTyping(thread: ChannelThreadRef): Promise<void>;
  /** Returns null without a current, explicitly scoped native binding. */
  resolveUser(channelUserId: string): Promise<ChannelIdentity | null>;
}
