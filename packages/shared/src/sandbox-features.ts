/** Minimal capability input for matrix projection (matches @shiba/sandbox flags). */
export interface SandboxCapabilityFlags {
  edgeEgressEnforcement: boolean;
  previewUrls: boolean;
  snapshots: boolean;
  backgroundProcesses: boolean;
  persistentVolumes?: boolean;
}

/** Operator-facing capability matrix for doctor + preflight. */
export interface SandboxFeatureMatrix {
  exec: boolean;
  files: boolean;
  portsPreview: boolean;
  snapshots: boolean;
  volumes: boolean;
  edgeEgress: boolean;
}

export const SANDBOX_RUN_FEATURES = [
  "exec",
  "files",
  "portsPreview",
  "snapshots",
  "volumes",
  "edgeEgress",
] as const;
export type SandboxRunFeature = (typeof SANDBOX_RUN_FEATURES)[number];

export function sandboxFeatureMatrix(capabilities: SandboxCapabilityFlags): SandboxFeatureMatrix {
  return {
    exec: true,
    files: true,
    portsPreview: capabilities.previewUrls && capabilities.backgroundProcesses,
    snapshots: capabilities.snapshots,
    volumes: capabilities.persistentVolumes === true,
    edgeEgress: capabilities.edgeEgressEnforcement,
  };
}

export function missingSandboxFeatures(
  capabilities: SandboxCapabilityFlags,
  required: readonly SandboxRunFeature[],
): SandboxRunFeature[] {
  const matrix = sandboxFeatureMatrix(capabilities);
  return required.filter((feature) => !matrix[feature]);
}

export function formatMissingSandboxFeatures(missing: readonly SandboxRunFeature[]): string {
  return missing.join(", ");
}
