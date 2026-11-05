import type { JSX } from "react";
import type { CustomAgentMascotPreset } from "@shiba/shared";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";

export function AgentChatEmptyState({ agent }: { agent: { id: string; name: string; role?: EmployeeRole; mascotPreset?: CustomAgentMascotPreset } }): JSX.Element {
  return (
    <section aria-label={`Conversation with ${agent.name}`} className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <AgentAvatar id={agent.id} name={agent.name} mascotPreset={agent.mascotPreset} role={agent.role} size={64} decorative />
      <h2 className="text-base font-medium text-[var(--fg)]">{agent.name}</h2>
      <p className="max-w-sm text-sm leading-relaxed text-[var(--muted-foreground-2)]">
        This is the beginning of your conversation. Messages are visible only to its participants.
      </p>
    </section>
  );
}
