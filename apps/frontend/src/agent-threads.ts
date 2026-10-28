import type { CustomAgentWire } from "./components/CustomAgentsView";
import type { RenamedThread } from "./components/ThreadTitleEditor";
import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";

export interface WebThread {
  id: string;
  name: string;
  agentName: string;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

/** Create a fresh conversation; never attach an agent to an unrelated existing session. */
export async function createAgentThread(agent: CustomAgentWire): Promise<WebThread> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: agent.config.name, metadata: { customAgentId: agent.id } }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    session?: WebThread;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `Could not create a bot thread (${response.status}).`);
  }
  const session = body.session;
  if (
    !session || session.id === "default" || typeof session.id !== "string" || !session.id.trim() ||
    typeof session.name !== "string" || typeof session.agentName !== "string" ||
    typeof session.updatedAt !== "number" || !Number.isFinite(session.updatedAt) ||
    threadAgentId(session) !== agent.id
  ) throw new Error("The server did not return a new thread. Try again.");
  return session;
}

export function threadAgentId(session: WebThread | undefined): string {
  return typeof session?.metadata?.customAgentId === "string" ? session.metadata.customAgentId : "";
}

export function agentThreads(threads: WebThread[], agentId: string): WebThread[] {
  return threads.filter((thread) => thread.id !== "default" && threadAgentId(thread) === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A delayed response for a prior visit must not replace a more recent rename. */
export function applyThreadRename(threads: WebThread[], renamed: RenamedThread): WebThread[] {
  return threads.map((thread) => thread.id === renamed.id && renamed.updatedAt >= thread.updatedAt
    ? { ...thread, name: renamed.name, updatedAt: renamed.updatedAt }
    : thread);
}

export async function loadThreadMessages(
  name: string,
  url: string | undefined,
  activeName: { current: string | null },
): Promise<UIMessage[]> {
  if (!url || !activeName.current || name !== activeName.current) return [];
  const response = await fetch(`${url}/get-messages`, { credentials: "include" });
  if (!response.ok || name !== activeName.current) return [];
  const text = await response.text();
  if (!text.trim() || name !== activeName.current) return [];
  try {
    const messages = JSON.parse(text);
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

/** Apply bound bot defaults once per thread/profile version, including late registry loads. */
export function useAgentThreadDefaults(
  sessionId: string,
  agentId: string,
  agents: CustomAgentWire[],
  onProfile: (profile: CustomAgentWire) => void,
) {
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const profile = agents.find((agent) => agent.id === agentId);
    const key = JSON.stringify([sessionId, agentId, profile?.version ?? null]);
    if (key === applied.current) return;
    applied.current = key;
    if (profile) onProfile(profile);
  }, [sessionId, agentId, agents, onProfile]);
}
