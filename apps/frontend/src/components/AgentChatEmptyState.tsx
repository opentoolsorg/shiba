import type { JSX } from "react";
import type { AgentAvatarChoice, AgentMascotLook, CustomAgentMascotPreset } from "@shiba/shared";
import { EMPLOYEE_TEMPLATES, employeeRole, type EmployeeRole } from "../employee-templates";
import { employeeExamples } from "./AgentExperience";
import { AgentAvatar } from "./AgentAvatar";

export function AgentChatEmptyState({ agent, onOpenToolPolicy }: { agent: { id: string; name: string; role?: EmployeeRole; slug?: string; roleTemplateId?: EmployeeRole; mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook; avatar?: AgentAvatarChoice }; onOpenToolPolicy?: () => void }): JSX.Element {
  const role = employeeRole(agent.slug, agent.roleTemplateId as never ?? agent.role as never);
  const template = EMPLOYEE_TEMPLATES.find((item) => item.id === role);
  const examples = employeeExamples({ id: agent.id, slug: agent.slug, config: { roleTemplateId: role === "custom" ? undefined : role } } as never);
  return (
    <section aria-label={`Conversation with ${agent.name}`} className="flex shrink-0 flex-col items-center gap-3 px-6 py-6 text-center">
      <AgentAvatar id={agent.id} name={agent.name} mascotPreset={agent.mascotPreset} look={agent.look} avatar={agent.avatar} role={role} size={64} decorative />
      <h2 className="text-base font-medium text-[var(--fg)]">{agent.name}</h2>
      <p className="max-w-sm text-sm leading-relaxed text-[var(--muted-foreground-2)]">{template?.description ?? "This is the beginning of your conversation. Messages are visible only to its participants."}</p>
      <p className="text-xs text-[var(--muted-foreground-2)]">No sandbox work starts until you approve the exact request.</p>
      {onOpenToolPolicy ? <button type="button" onClick={onOpenToolPolicy} className="text-xs text-[var(--primary)] underline underline-offset-2">Review tool policy</button> : null}
      {examples.length ? <div className="mt-2 flex max-w-2xl flex-wrap justify-center gap-2">{examples.map((example) => <span key={example} className="rounded-lg border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground-1)]">{example}</span>)}</div> : null}
    </section>
  );
}
