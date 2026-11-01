import type { JSX } from "react";

export function ShibaMark({ className = "size-14" }: { className?: string }): JSX.Element {
  return (
    <img
      src="/assets/mascot/pet-logo.png"
      alt="Shiba"
      width={128}
      height={128}
      className={`${className} shrink-0 rounded-lg border border-[var(--border-1)] bg-[var(--card)] object-contain`}
    />
  );
}
