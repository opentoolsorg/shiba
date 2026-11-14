import type { DelegatedRun } from "@shiba/shared";

export interface RunProofSnapshot {
  screenshotUrl: string | null;
  browserE2eManifestUrl: string | null;
  previewUrl: string | null;
  testOutputTail: string | null;
  pullUrl: string | null;
}

/** Proof tab projection — metadata only, no secret bodies. */
export function buildRunProof(run: DelegatedRun): RunProofSnapshot {
  const testLike = (run.deliverables ?? []).find((item) => /(?:test|spec|junit|vitest)/i.test(item.path));
  const tailSource = testLike
    ? `[${testLike.path}] (${testLike.bytes} bytes)`
    : run.summary?.trim() ?? "";
  const previewFromManifest = run.browserE2eManifestUrl ?? null;
  return {
    screenshotUrl: run.screenshotUrl ?? null,
    browserE2eManifestUrl: run.browserE2eManifestUrl ?? null,
    previewUrl: previewFromManifest,
    testOutputTail: tailSource ? tailSource.slice(-4000) : null,
    pullUrl: run.pullUrl ?? null,
  };
}