import type { SandboxCapabilities } from "../types.js";

/**
 * Honest capability defaults per ComputeSDK backend provider name.
 * Sources: ComputeSDK provider READMEs + shiba spot-checks (2026-10-19).
 * Cells marked NOT VERIFIED in COMPUTESDK-MATRIX.md were not live-tested.
 */
const BASE: SandboxCapabilities = {
  edgeEgressEnforcement: false,
  previewUrls: false,
  snapshots: false,
  streamingExec: true,
  backgroundProcesses: true,
  rawProviderHandle: true,
} satisfies SandboxCapabilities;

/** Shiba Worker edge egress is never provided by ComputeSDK — only native `cloudflare` adapter. */
export function capabilitiesForComputesdkBackend(name: string): SandboxCapabilities {
  const id = name.trim().toLowerCase();
  switch (id) {
    case "e2b":
    case "modal":
    case "daytona":
    case "vercel":
    case "northflank":
    case "lizard":
    case "runtime":
    case "miosa":
    case "mosaic":
    case "novita":
    case "neevcloud":
    case "gravixlayer":
    case "buddy":
    case "opencomputer":
    case "freestyle":
    case "createos-sandbox":
      return { ...BASE, previewUrls: true, snapshots: true };
    case "cloudflare":
      // ComputeSDK's @computesdk/cloudflare is a remote HTTP sandbox — not Worker SandboxOutbound.
      return { ...BASE, previewUrls: true };
    case "microsandbox":
      return { ...BASE, previewUrls: true };
    default:
      return { ...BASE };
  }
}

export const COMPUTESDK_PINNED_CORE_VERSION = "4.1.12";
