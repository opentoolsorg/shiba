import { useCallback, useEffect, useRef, useState } from "react";

export interface ConversationRoomViewer {
  viewerId: string;
  joinedAt: number;
  typing: boolean;
}

export interface ConversationRoomMessage {
  messageId: string;
  viewerId: string;
  role: "user";
  text: string;
  createdAt: number;
}

export interface ConversationRoomStream {
  streamId: string;
  viewerId: string;
  text: string;
}

export type ConversationRoomStatus = "offline" | "connecting" | "connected" | "reconnecting";

interface ChatMessageLike {
  id: string;
  role: string;
  metadata?: unknown;
  parts?: Array<{ type?: string; text?: string }>;
}

interface UseConversationRoomRealtimeOptions {
  sessionId: string;
  enabled: boolean;
  typingText: string;
  messages: readonly ChatMessageLike[];
  onMessage: (message: ConversationRoomMessage) => void;
}

interface LocalPublisher {
  streamId: string;
  baselineAssistantIds: Set<string>;
  baselineUserMessageIds: Set<string>;
  sentUserMessageIds: Set<string>;
  userText: string;
  lastText: string;
  endStatus?: "complete" | "failed";
}

const MAX_ROOM_STREAM_CHARS = 50_000;
const ROOM_STREAM_CHUNK_CHARS = 1_000;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (slot) => {
    const value = Math.floor(Math.random() * 16);
    return (slot === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function messageText(message: ChatMessageLike): string {
  if (!Array.isArray(message.parts)) return "";
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function viewerMessageOwner(message: ChatMessageLike): string | null {
  if (typeof message.metadata !== "object" || message.metadata === null) return null;
  const viewerId = (message.metadata as Record<string, unknown>).shibaRoomViewerId;
  return typeof viewerId === "string" ? viewerId : null;
}

function belongsToLocalPublisher(message: ChatMessageLike, publisher: LocalPublisher, viewerId: string): boolean {
  const owner = viewerMessageOwner(message);
  if (owner !== null) return owner === viewerId;
  return !publisher.baselineUserMessageIds.has(message.id) &&
    Boolean(publisher.userText) && messageText(message).trim() === publisher.userText;
}

function latestLocalAssistantText(
  messages: readonly ChatMessageLike[],
  publisher: LocalPublisher,
): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && !publisher.baselineAssistantIds.has(message.id)) {
      return messageText(message);
    }
  }
  return "";
}

function sendStreamText(
  send: (event: unknown) => boolean,
  publisher: LocalPublisher,
  text: string,
): boolean {
  const target = text.slice(0, MAX_ROOM_STREAM_CHARS);
  while (publisher.lastText.length < target.length) {
    const delta = target.slice(
      publisher.lastText.length,
      publisher.lastText.length + ROOM_STREAM_CHUNK_CHARS,
    );
    if (!send({ type: "stream:delta", streamId: publisher.streamId, delta })) return false;
    publisher.lastText += delta;
  }
  return true;
}

export function useConversationRoomRealtime({
  sessionId,
  enabled,
  typingText,
  messages,
  onMessage,
}: UseConversationRoomRealtimeOptions) {
  const [viewerId] = useState(newId);
  const [status, setStatus] = useState<ConversationRoomStatus>(enabled ? "connecting" : "offline");
  const [viewers, setViewers] = useState<ConversationRoomViewer[]>([]);
  const [remoteStream, setRemoteStream] = useState<ConversationRoomStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const messagesRef = useRef(messages);
  const publisherRef = useRef<LocalPublisher | null>(null);
  const typingSentRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onMessageRef.current = onMessage;
  messagesRef.current = messages;

  const send = useCallback((event: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("offline");
      setViewers([]);
      setRemoteStream(null);
      return;
    }

    let stopped = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      const url = new URL(
        `/api/sessions/${encodeURIComponent(sessionId)}/realtime`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("viewer", viewerId);
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        attempt++;
        reconnectTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)));
        return;
      }
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (stopped || socketRef.current !== socket) return;
        attempt = 0;
        setStatus("connected");
        const publisher = publisherRef.current;
        if (publisher) {
          send({ type: "stream:start", streamId: publisher.streamId });
          for (const message of messagesRef.current) {
            if (
              message.role === "user" && belongsToLocalPublisher(message, publisher, viewerId) &&
              !publisher.sentUserMessageIds.has(message.id)
            ) {
              const text = messageText(message).trim();
              if (text && send({ type: "message", messageId: message.id, text })) {
                publisher.sentUserMessageIds.add(message.id);
              }
            }
          }
          const contentSynced = sendStreamText(
            send,
            publisher,
            latestLocalAssistantText(messagesRef.current, publisher),
          );
          if (publisher.endStatus && contentSynced && send({
            type: "stream:end", streamId: publisher.streamId, status: publisher.endStatus,
          })) {
            publisherRef.current = null;
          }
        }
      });
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof data !== "object" || data === null) return;
        const frame = data as Record<string, unknown>;
        if (frame.type === "snapshot") {
          setViewers(Array.isArray(frame.viewers) ? frame.viewers as ConversationRoomViewer[] : []);
          if (Array.isArray(frame.messages)) {
            for (const message of frame.messages) {
              if (typeof message === "object" && message !== null) {
                const roomMessage = message as Record<string, unknown>;
                if (typeof roomMessage.messageId === "string" && typeof roomMessage.viewerId === "string" &&
                  typeof roomMessage.text === "string" && typeof roomMessage.createdAt === "number") {
                  onMessageRef.current({
                    messageId: roomMessage.messageId,
                    viewerId: roomMessage.viewerId,
                    role: "user",
                    text: roomMessage.text,
                    createdAt: roomMessage.createdAt,
                  });
                }
              }
            }
          }
          const streams = Array.isArray(frame.streams) ? frame.streams as ConversationRoomStream[] : [];
          setRemoteStream(streams.find((stream) => stream.viewerId !== viewerId) ?? null);
        } else if (frame.type === "presence" && Array.isArray(frame.viewers)) {
          setViewers(frame.viewers as ConversationRoomViewer[]);
        } else if (frame.type === "message" && frame.viewerId !== viewerId &&
          typeof frame.messageId === "string" && typeof frame.text === "string" &&
          typeof frame.createdAt === "number") {
          onMessageRef.current({
            messageId: frame.messageId,
            viewerId: String(frame.viewerId),
            role: "user",
            text: frame.text,
            createdAt: frame.createdAt,
          });
        } else if (frame.type === "stream:start" && frame.viewerId !== viewerId && typeof frame.streamId === "string") {
          setRemoteStream({ streamId: frame.streamId, viewerId: String(frame.viewerId), text: "" });
        } else if (frame.type === "stream:delta" && frame.viewerId !== viewerId &&
          typeof frame.streamId === "string" && typeof frame.text === "string") {
          setRemoteStream({ streamId: frame.streamId, viewerId: String(frame.viewerId), text: frame.text });
        } else if (frame.type === "stream:end" && typeof frame.streamId === "string") {
          setRemoteStream((current) => current?.streamId === frame.streamId ? null : current);
        }
      });
      socket.addEventListener("close", () => {
        if (stopped || socketRef.current !== socket) return;
        socketRef.current = null;
        setStatus("reconnecting");
        setViewers([]);
        setRemoteStream(null);
        attempt++;
        reconnectTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)));
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socketRef.current) socketRef.current.close();
      socketRef.current = null;
      setViewers([]);
      setRemoteStream(null);
    };
  }, [enabled, send, sessionId, viewerId]);

  useEffect(() => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (status !== "connected" || !typingText.trim()) {
      if (typingSentRef.current) send({ type: "typing", typing: false });
      typingSentRef.current = false;
      return;
    }
    if (!typingSentRef.current) send({ type: "typing", typing: true });
    typingSentRef.current = true;
    typingTimerRef.current = setTimeout(() => {
      send({ type: "typing", typing: false });
      typingSentRef.current = false;
      typingTimerRef.current = null;
    }, 2_000);
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [send, status, typingText]);

  useEffect(() => {
    const publisher = publisherRef.current;
    if (!publisher) return;
    for (const message of messages) {
      if (
        message.role === "user" && belongsToLocalPublisher(message, publisher, viewerId) &&
        !publisher.sentUserMessageIds.has(message.id)
      ) {
        const text = messageText(message).trim();
        if (text && send({ type: "message", messageId: message.id, text })) {
          publisher.sentUserMessageIds.add(message.id);
        }
      }
    }
    const text = latestLocalAssistantText(messages, publisher);
    sendStreamText(send, publisher, text);
  }, [messages, send, viewerId]);

  const startStream = useCallback((userText = "") => {
    const streamId = newId();
    if (publisherRef.current) {
      send({ type: "stream:end", streamId: publisherRef.current.streamId, status: "failed" });
    }
    publisherRef.current = {
      streamId,
      baselineAssistantIds: new Set(messagesRef.current.filter((message) => message.role === "assistant").map((message) => message.id)),
      baselineUserMessageIds: new Set(messagesRef.current.filter((message) => message.role === "user").map((message) => message.id)),
      sentUserMessageIds: new Set(),
      userText: userText.trim(),
      lastText: "",
    };
    send({ type: "stream:start", streamId });
    return streamId;
  }, [send]);

  const finishStream = useCallback((streamId: string, status: "complete" | "failed") => {
    const publisher = publisherRef.current;
    if (!publisher || publisher.streamId !== streamId) return;
    const contentSynced = sendStreamText(
      send,
      publisher,
      latestLocalAssistantText(messagesRef.current, publisher),
    );
    publisher.endStatus = status;
    if (contentSynced && send({ type: "stream:end", streamId, status })) publisherRef.current = null;
  }, [send]);

  return {
    viewerId,
    status,
    viewers,
    remoteStream,
    startStream,
    finishStream,
  };
}
