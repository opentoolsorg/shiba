const MAX_LOCAL_URL_CHARS = 2048;

export interface LocalBrowserAddress {
  href: string;
  origin: string;
}

export function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function parseLocalBrowserAddress(value: unknown): LocalBrowserAddress | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOCAL_URL_CHARS) return null;
  if (hasAsciiControlCharacter(value)) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return { href: url.href, origin: url.origin };
  } catch {
    return null;
  }
}

export interface NativeWindowEnvironment {
  platform: string;
  display?: string;
  waylandDisplay?: string;
  sessionType?: string;
}

export interface NativeWindowAvailability {
  available: false;
  reason: string;
}

export function nativeWindowAvailability(env: NativeWindowEnvironment): NativeWindowAvailability {
  const linuxSession = env.platform === "linux" && (env.sessionType === "x11" || Boolean(env.display && !env.waylandDisplay));
  if (linuxSession) {
    return {
      available: false,
      reason: "Native window control is unavailable on this Linux/X11 session because input cannot be safely bound to one window.",
    };
  }
  return {
    available: false,
    reason: "This build has no verified OS-scoped native window capture and input provider.",
  };
}
