/**
 * Minimal sandbox capability seam (PR #123 stand-in on this branch).
 * Providers declare what optional layers they support; orchestration
 * degrades when a flag is off or the provider lacks a capability.
 */
export type SandboxCapability = "preview" | "exec" | "files" | "desktop";

export interface SandboxProviderCapabilities {
  readonly provider: "cloudflare-sandbox";
  readonly capabilities: readonly SandboxCapability[];
}

/** Default Cloudflare Containers sandbox — desktop is opt-in at deploy + run time. */
export const CLOUDFLARE_SANDBOX_CAPABILITIES: SandboxProviderCapabilities = {
  provider: "cloudflare-sandbox",
  capabilities: ["preview", "exec", "files", "desktop"],
};

export function providerSupports(
  caps: SandboxProviderCapabilities,
  capability: SandboxCapability,
): boolean {
  return caps.capabilities.includes(capability);
}

/** noVNC / websockify listens here inside the container when desktop is up. */
export const SANDBOX_DESKTOP_PORT = 6080;

/** In-container VNC password env var — never logged or returned on the wire. */
export const SANDBOX_VNC_PASSWORD_ENV = "SHIBA_VNC_PASSWORD";
