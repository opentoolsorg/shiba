import type { DesktopCapability, ShibaDesktopBridge } from "@shiba/shared";

/**
 * The shell advertises the capabilities it implements (`capabilities` in the
 * bridge handshake). The dashboard reads that list instead of probing for
 * methods, so a control is only rendered when the call behind it exists.
 */
export function desktopHasCapability(
  bridge: ShibaDesktopBridge | undefined,
  capability: DesktopCapability,
): boolean {
  const advertised = bridge?.capabilities;
  return Array.isArray(advertised) && advertised.includes(capability);
}

export function desktopCanSignInClaude(
  bridge: ShibaDesktopBridge | undefined,
  providerId: string,
): boolean {
  return providerId === "claude" && desktopHasCapability(bridge, "claudeLogin");
}
