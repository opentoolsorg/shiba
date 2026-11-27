import type { JSX } from "react";
import type { AgentMascotLook } from "@shiba/shared";
import { AgentMascot } from "./AgentMascot";

/**
 * The app mark uses the shared robot mascot, with the neutral Shiba shell.
 * Decorative wherever it sits beside the word Shiba.
 */
export const SHIBA_BRAND_LOOK: AgentMascotLook = { shape: "squircle", color: "#27272a", eyes: "pill", acc: "none" };

export function ShibaMark({ className = "size-14", decorative = false, label = "Shiba" }: { className?: string; decorative?: boolean; label?: string }): JSX.Element {
  const classes = `${className} inline-flex shrink-0`;
  const mark = <AgentMascot look={SHIBA_BRAND_LOOK} />;
  if (decorative) return <span aria-hidden="true" className={classes}>{mark}</span>;
  return <span role="img" aria-label={label} className={classes}>{mark}</span>;
}
