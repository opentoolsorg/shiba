import type { FounderMetaGrant } from "@shiba/shared";
export const META_WORKSPACE = `ws_${"a".repeat(24)}`, META_ACTOR = "founder@example.test";
export const metaScope = { workspaceId: META_WORKSPACE, actorId: META_ACTOR };
export function metaGrant(): FounderMetaGrant { return { id: `fmc_${"b".repeat(32)}`, accountId: "123456789", revision: 1, expiresAt: Date.now() + 86400000, fingerprint: "c".repeat(64), digest: "d".repeat(64), selection: { since: "2026-01-01", until: "2026-01-07", limit: 10 }, maxCalls: 3, usedCalls: 0, state: "draft", nextDueAt: null, executorDigest: "f".repeat(64), apiVersion: "v25.0", schedule: "daily-fixed-interval", maxBytes: 32768, maxDurationMs: 5000, maxPages: 1, currency: null, timezoneName: null }; }
