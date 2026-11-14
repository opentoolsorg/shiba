export type JumpPlatform = "mac" | "other";

export function detectPlatform(agent = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`): JumpPlatform {
  return /Mac|iPhone|iPad/.test(agent) ? "mac" : "other";
}

export function detectStandalone(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/** Label for the jump binding that actually fires on this platform. */
export function jumpKeyLabel(n: number, platform: JumpPlatform, standalone: boolean): string {
  if (standalone) return platform === "mac" ? `⌘${n}` : `Ctrl+${n}`;
  return platform === "mac" ? `⌃${n}` : `Alt+Shift+${n}`;
}

export function jumpKeyAria(n: number, platform: JumpPlatform, standalone: boolean): string {
  if (standalone) return platform === "mac" ? `Meta+${n}` : `Control+${n}`;
  return platform === "mac" ? `Control+${n}` : `Alt+Shift+${n}`;
}

export function jumpEventMatches(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  n: number,
  platform: JumpPlatform,
  standalone: boolean,
): boolean {
  if (event.key !== String(n)) return false;
  if (standalone) {
    return platform === "mac"
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  }
  if (platform === "mac") return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  return event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey;
}
