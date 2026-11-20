/**
 * Email channel: inbound mail as a task front door, replies through the
 * SEND_EMAIL binding.
 *
 * Mail does not arrive over HTTP. The inbound handler parses the MIME
 * message once and hands this transport a JSON envelope (see
 * {@link buildEmailEnvelope}) plus the message's own headers. Email is
 * spoofable, so the authentication is the receiving MTA's verdict:
 * Cloudflare Email Routing prepends one `Authentication-Results` header
 * under the `mx.cloudflare.net` authserv-id. Only that first header is
 * trusted; any later one may have been written by the sender.
 *
 * The channel has no actions. Nothing a sender writes, a reply included,
 * can decide an approval; approvals stay in the dashboard and Slack.
 */
import type { Env } from "../../env.js";
import {
  ChannelUnsupportedError,
  type ChannelAdapter,
  type ChannelCapability,
  type ChannelDefinition,
  type ChannelTransport,
  type InboundEvent,
  type InboundMessage,
} from "../../ports/channel/index.js";

const EMAIL_AUTHSERV_ID = "mx.cloudflare.net";

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const MESSAGE_ID_RE = /^<[!-;=?-~]{1,250}>$/;
const CAPABILITIES: ReadonlySet<ChannelCapability> = new Set<ChannelCapability>(["post"]);

/** What the inbound handler hands the transport, serialized as the raw body. */
export interface EmailEnvelope {
  v: 1;
  /** Bracketed RFC822 Message-ID. */
  messageId: string;
  /** Header From address: the identity DMARC aligns. */
  from: string;
  fromName?: string;
  /** Registered mailbox the mail was delivered to. */
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** Auto-Submitted, Precedence bulk/list/auto_reply, or List-Id was present. */
  autoSubmitted: boolean;
}

function bracketed(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  const value = trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
  return MESSAGE_ID_RE.test(value) ? value : undefined;
}

/** True for mail a machine sent on its own; replying to it risks a loop. */
function isAutoSubmitted(headers: Headers): boolean {
  const autoSubmitted = headers.get("auto-submitted")?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const precedence = headers.get("precedence")?.trim().toLowerCase();
  if (precedence && ["bulk", "junk", "list", "auto_reply"].includes(precedence)) return true;
  return headers.has("list-id");
}

export function buildEmailEnvelope(input: {
  messageId?: string;
  from?: string;
  fromName?: string;
  to: string;
  subject?: string;
  text?: string | null;
  inReplyTo?: string;
  references?: string[];
  headers: Headers;
}): EmailEnvelope | null {
  const messageId = bracketed(input.messageId);
  const from = input.from?.trim().toLowerCase();
  if (!messageId || !from || !ADDRESS_RE.test(from)) return null;
  const inReplyTo = bracketed(input.inReplyTo);
  const references = (input.references ?? [])
    .map(bracketed)
    .filter((id): id is string => id !== undefined);
  return {
    v: 1,
    messageId,
    from,
    ...(input.fromName?.trim() ? { fromName: input.fromName.trim() } : {}),
    to: input.to.trim().toLowerCase(),
    subject: input.subject?.trim() ?? "",
    text: input.text ?? "",
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    autoSubmitted: isAutoSubmitted(input.headers),
  };
}

function parseEnvelope(rawBody: string): EmailEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Partial<EmailEnvelope>;
  if (
    envelope.v !== 1 ||
    typeof envelope.messageId !== "string" ||
    typeof envelope.from !== "string" ||
    typeof envelope.to !== "string" ||
    typeof envelope.subject !== "string" ||
    typeof envelope.text !== "string" ||
    !ADDRESS_RE.test(envelope.from) ||
    !ADDRESS_RE.test(envelope.to)
  )
    return null;
  return envelope as EmailEnvelope;
}

/**
 * The receiving MTA's header only. Headers.get joins repeated headers with
 * ", ", and Cloudflare prepends its own. Do not look beyond the first comma,
 * even if that means ignoring a verdict with an unusual comment.
 */
function firstAuthenticationResults(headers: Headers): string {
  const combined = headers.get("authentication-results") ?? "";
  return (combined.split(",", 1)[0] ?? "").trim();
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Body text with quoted history and signatures removed. */
export function stripQuotedReply(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (
      /^On .{1,200}wrote:\s*$/.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
      /^-- ?$/.test(line) ||
      /^_{10,}$/.test(line)
    )
      break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Subject without reply and forward prefixes. */
export function cleanSubject(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|fw|fwd|aw)\s*:\s*)+/i, "").trim();
}

function conversationKeyFor(sender: string): string {
  return ADDRESS_RE.test(sender) ? `email:${sender}` : "";
}

export const emailTransport: ChannelTransport = {
  channel: "email",
  async verify(rawBody, headers, env) {
    if (!env.EMAIL_TASK_SENDERS?.trim() || !env.EMAIL_TASK_EMPLOYEES?.trim()) {
      return { ok: false, status: 503, error: "Email task intake is not configured." };
    }
    const [authserv = "", ...props] = firstAuthenticationResults(headers)
      .split(";")
      .map((part) => part.trim());
    const dmarc = props.find((prop) => /^dmarc=/i.test(prop));
    if (
      authserv.toLowerCase() !== EMAIL_AUTHSERV_ID ||
      !dmarc ||
      !/^dmarc=pass(?:\s|$)/i.test(dmarc) ||
      !props.some((prop) => /^(?:spf|dkim)=pass(?:\s|$)/i.test(prop))
    ) {
      return {
        ok: false,
        status: 401,
        error: "The sender's domain did not pass DMARC at the receiving server.",
      };
    }
    const envelope = parseEnvelope(rawBody);
    if (!envelope) return { ok: false, status: 401, error: "Email envelope is malformed." };
    const headerFrom = /\bheader\.from=([^\s;]+)/i.exec(dmarc)?.[1]?.toLowerCase();
    if (headerFrom && headerFrom !== domainOf(envelope.from)) {
      return {
        ok: false,
        status: 401,
        error: "The DMARC verdict names a different sender domain.",
      };
    }
    return { ok: true };
  },
  parse(rawBody): InboundMessage | null {
    const envelope = parseEnvelope(rawBody);
    if (!envelope) return null;
    const body = stripQuotedReply(envelope.text);
    const subject = cleanSubject(envelope.subject);
    return {
      kind: "message",
      channel: "email",
      deliveryId: envelope.messageId,
      conversationKey: conversationKeyFor(envelope.from),
      placeId: envelope.from,
      workspaceId: envelope.to,
      messageId: envelope.messageId,
      threadId: envelope.references?.[0] ?? envelope.inReplyTo ?? envelope.messageId,
      authorId: envelope.from,
      ...(envelope.fromName ? { authorName: envelope.fromName } : {}),
      text: [subject, body].filter(Boolean).join("\n\n"),
      mentionedUserIds: [],
      isDirect: true,
      isBot: envelope.autoSubmitted,
      raw: envelope,
    };
  },
  conversationKey: (event: InboundEvent) => conversationKeyFor(event.placeId),
};

/**
 * Post-only adapter. `native.from` names the registered mailbox to send as
 * and `native.subject` the subject line; `replyToMessageId` threads it.
 */
export function createEmailAdapter(sendEmail: SendEmail): ChannelAdapter {
  const unsupported = (capability: ChannelCapability) =>
    Promise.reject(new ChannelUnsupportedError("email", capability));
  return {
    channel: "email",
    capabilities: CAPABILITIES,
    async post(post) {
      const from = typeof post.native?.from === "string" ? post.native.from.trim() : "";
      const subject = typeof post.native?.subject === "string" ? post.native.subject : "";
      if (!ADDRESS_RE.test(post.placeId) || !ADDRESS_RE.test(from))
        throw new Error("Email post needs a valid sender and recipient.");
      if (/[\r\n]/.test(subject)) throw new Error("Email subject must be a single line.");
      const inReplyTo = bracketed(post.replyToMessageId);
      const { messageId } = await sendEmail.send({
        from,
        to: post.placeId,
        subject,
        text: post.text,
        headers: {
          "Auto-Submitted": "auto-replied",
          ...(inReplyTo ? { "In-Reply-To": inReplyTo, References: inReplyTo } : {}),
        },
      });
      return { placeId: post.placeId, messageId };
    },
    edit: () => unsupported("edit"),
    react: () => unsupported("react"),
    upload: () => unsupported("upload"),
    download: () => unsupported("download"),
    history: () => unsupported("history"),
    recent: () => unsupported("recent"),
    authorName: () => unsupported("authorName"),
    placeName: () => unsupported("placeName"),
    mentions: () => [],
  };
}

export const emailChannel: ChannelDefinition = {
  id: "email",
  requiredSecrets: ["EMAIL_TASK_SENDERS", "EMAIL_TASK_EMPLOYEES"],
  transport: emailTransport,
  createAdapter(env: Env) {
    return env.SEND_EMAIL ? createEmailAdapter(env.SEND_EMAIL) : null;
  },
};
