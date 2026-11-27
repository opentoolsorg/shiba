import type { JSX } from "react";
import type { AgentMascotLook } from "@shiba/shared";

/** Built-in Shiba employee look used by the generic employee-mascot renderer; the main product mark below is the robot. */
export const SHIBA_BRAND_LOOK: AgentMascotLook = { shape: "squircle", color: "#27272a", eyes: "pill", acc: "none" };

function RobotMark(): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" className="shiba-robot-mark size-full overflow-visible" aria-hidden="true">
      <path d="M32 12v8" stroke="#e88767" strokeWidth="4" strokeLinecap="round" />
      <circle cx="32" cy="8" r="4.2" fill="#fff" stroke="#e88767" strokeWidth="3" />
      <rect x="8" y="30" width="8" height="15" rx="4" fill="#e88767" />
      <rect x="48" y="30" width="8" height="15" rx="4" fill="#e88767" />
      <rect x="15" y="17" width="34" height="38" rx="17" fill="#e88767" />
      <rect x="19" y="26" width="26" height="17" rx="8.5" fill="#171a20" />
      <rect x="22" y="28.5" width="20" height="2.4" rx="1.2" fill="#2b3442" />
      <circle cx="26" cy="35" r="2.1" fill="#f6fbff" />
      <circle cx="38" cy="35" r="2.1" fill="#f6fbff" />
    </svg>
  );
}

/** Main Shiba robot mark. Decorative wherever it sits beside the word Shiba. */
export function ShibaMark({ className = "size-14", decorative = false, label = "Shiba" }: { className?: string; decorative?: boolean; label?: string }): JSX.Element {
  const classes = `${className} inline-flex shrink-0`;
  const mark = <RobotMark />;
  if (decorative) return <span aria-hidden="true" className={classes}>{mark}</span>;
  return <span role="img" aria-label={label} className={classes}>{mark}</span>;
}
