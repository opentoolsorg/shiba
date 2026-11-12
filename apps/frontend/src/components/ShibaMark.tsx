import type { JSX } from "react";
import { defaultLookFor } from "@shiba/shared";
import { AgentMascot } from "./AgentMascot";

export function ShibaMark({ className = "size-14", decorative = false }: { className?: string; decorative?: boolean }): JSX.Element {
  return (
    <span role="img" aria-label="Shiba" aria-hidden={decorative || undefined} className={`${className} inline-flex shrink-0 rounded-lg border border-[var(--border-1)] bg-[var(--card)]`}>
      <AgentMascot look={defaultLookFor("shiba")} />
    </span>
  );
}
