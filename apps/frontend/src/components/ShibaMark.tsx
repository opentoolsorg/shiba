import type { JSX } from "react";

/** Login mark drawn in the page so a missing /assets file cannot leave a blank circle. */
export function ShibaMark({ className = "size-14" }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Shiba"
      className={`${className} rounded-full border border-[var(--primary)]/40 bg-[var(--card)]`}
    >
      <circle cx="32" cy="32" r="30" fill="var(--primary-soft, #f4e7d4)" />
      <path d="M16 24 22 14l8 8 8-8 6 10-6 4v16a10 10 0 0 1-20 0V28z" fill="#c4622d" />
      <ellipse cx="32" cy="40" rx="8" ry="6" fill="#f6d7b0" />
      <circle cx="27" cy="36" r="1.4" fill="#2a2118" />
      <circle cx="37" cy="36" r="1.4" fill="#2a2118" />
      <path d="M30 40h4l-2 2z" fill="#2a2118" />
    </svg>
  );
}
