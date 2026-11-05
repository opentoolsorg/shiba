import type { FounderStripeGrant } from "@shiba/shared";
export const STRIPE_WORKSPACE = `ws_${"a".repeat(24)}`;
export const STRIPE_ACTOR = "founder@example.test";
export function stripeGrant(): FounderStripeGrant { return { id: `fsc_${"b".repeat(32)}`, accountId: "acct_fixture", mode: "test", revision: 1, expiresAt: Date.now() + 86400000, fingerprint: "c".repeat(64), digest: "d".repeat(64), selection: { kind: "invoices", createdGte: 100, createdLt: 200, limit: 10 }, maxCalls: 3, usedCalls: 0, state: "draft", nextDueAt: null, executorDigest: "f".repeat(64), apiVersion: "2025-10-29.clover", schedule: "daily-fixed-interval", maxBytes: 32768, maxDurationMs: 5000, maxPages: 1 }; }
export const stripeScope = { workspaceId: STRIPE_WORKSPACE, actorId: STRIPE_ACTOR };
