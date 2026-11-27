import type { JSX } from "react";
import type { AgentMascotLook } from "@shiba/shared";

/** Robot look for the built-in Shiba employee avatar; distinct from the product brand mark. */
export const SHIBA_BRAND_LOOK: AgentMascotLook = { shape: "squircle", color: "#27272a", eyes: "pill", acc: "none" };

function DogMark(): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" className="size-full" data-brand-mark="shiba-dog" aria-hidden="true" focusable="false">
      <path d="M17 29 22 8 34 24Z" fill="#c96f4a" />
      <path d="M47 29 42 8 30 24Z" fill="#c96f4a" />
      <path d="M22.8 23.5 24.4 14 30 22.4Z" fill="#f2b29b" />
      <path d="M41.2 23.5 39.6 14 34 22.4Z" fill="#f2b29b" />
      <path d="M32 18 49 28 47 45 32 58 17 45 15 28Z" fill="#e07a5f" />
      <path d="M19 38c3.2 8.4 7.4 13 13 13s9.8-4.6 13-13c-3.1 3-7.3 4.6-13 4.6S22.1 41 19 38Z" fill="#fff3e8" />
      <circle cx="25" cy="33" r="2.2" fill="#171717" />
      <circle cx="39" cy="33" r="2.2" fill="#171717" />
      <path d="M29 39.4c0-1 1-1.8 3-1.8s3 .8 3 1.8c0 1.2-1.8 3.1-3 3.1s-3-1.9-3-3.1Z" fill="#171717" />
      <path d="M32 42.5v3.2m0 0c-1.2 2-3.4 2.4-5 .8m5-.8c1.2 2 3.4 2.4 5 .8" fill="none" stroke="#171717" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The product mark is one geometric Shiba dog. Decorative wherever it sits beside the word Shiba. */
export function ShibaMark({ className = "size-14", decorative = false, label = "Shiba" }: { className?: string; decorative?: boolean; label?: string }): JSX.Element {
  const classes = `${className} inline-flex shrink-0`;
  if (decorative) return <span aria-hidden="true" className={classes}><DogMark /></span>;
  return <span role="img" aria-label={label} className={classes}><DogMark /></span>;
}
