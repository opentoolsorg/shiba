import { describe, expect, it } from "vitest";
import { READ_PROVIDERS, seedFounderRead, type Evidence, type FounderReadSeed, type GrantPin, type ReadProvider } from "./fixtures/founder-read.js";

/**
 * D5. The evidence API (`pinGrant`, `grantFence`, `loadEvidence`, `completedReceipts`) through
 * reads/index only. Each refusal starts from evidence that was really issued, changes one thing,
 * and asks every part of the API that the change concerns.
 */
type Member = FounderReadSeed["member"];
interface Held {
  owner: Member;
  ref: { provider: ReadProvider; grantId: string; receiptId: string; grantRevision?: number };
  pin: GrantPin;
  evidence: Evidence;
}

/** Evidence as a consumer holds it straight after a completed read; fails the test if the module issues none. */
async function hold(seed: FounderReadSeed): Promise<Held> {
  const ref = { provider: seed.provider, grantId: seed.grantId, receiptId: seed.receiptId };
  const pin = await seed.reads.pinGrant(seed.env, seed.member, { ...ref, need: "serving" });
  const evidence = await seed.reads.loadEvidence(seed.env, seed.member, ref);
  expect(pin).not.toBeNull();
  expect(evidence).not.toBeNull();
  return { owner: seed.member, ref, pin: pin!, evidence: evidence! };
}

const probes = {
  "pinGrant returns null": async (seed: FounderReadSeed, held: Held) =>
    expect(await seed.reads.pinGrant(seed.env, held.owner, { provider: held.ref.provider, grantId: held.ref.grantId, need: "serving" })).toBeNull(),
  "loadEvidence returns null": async (seed: FounderReadSeed, held: Held) =>
    expect(await seed.reads.loadEvidence(seed.env, held.owner, held.ref)).toBeNull(),
  "grantFence selects no row": async (seed: FounderReadSeed, held: Held) =>
    expect(seed.holds(seed.reads.grantFence(held.pin, "serving"))).toBe(false),
  "completedReceipts does not select the receipt": async (seed: FounderReadSeed, held: Held) =>
    expect(seed.selected(seed.reads.completedReceipts(held.pin))).not.toContain(held.ref.receiptId),
  "the evidence fence selects no row": async (seed: FounderReadSeed, held: Held) =>
    expect(seed.holds(held.evidence.fence)).toBe(false),
} as const;
type Probe = keyof typeof probes;

interface Refusal {
  name: string;
  only?: readonly ReadProvider[];
  refuses: readonly Probe[];
  /** Changes one thing; returns what the consumer now asks with. */
  arrange(seed: FounderReadSeed, held: Held): Promise<Held> | Held;
}

const otherProvider = (provider: ReadProvider): ReadProvider => READ_PROVIDERS[(READ_PROVIDERS.indexOf(provider) + 1) % READ_PROVIDERS.length]!;

const refusals: Refusal[] = [
  {
    name: "a different owner",
    refuses: ["pinGrant returns null", "loadEvidence returns null", "grantFence selects no row", "completedReceipts does not select the receipt"],
    arrange(_seed, held) {
      const owner = { ...held.owner, accountId: "another-account" };
      return { ...held, owner, pin: { ...held.pin, ownerAccountId: owner.accountId, ownerJson: JSON.stringify(owner) } };
    },
  },
  {
    name: "a stale copy of the owner's membership",
    refuses: ["pinGrant returns null", "loadEvidence returns null", "grantFence selects no row", "completedReceipts does not select the receipt"],
    arrange(_seed, held) {
      const owner = { ...held.owner, version: held.owner.version + 1 };
      return { ...held, owner, pin: { ...held.pin, ownerJson: JSON.stringify(owner) } };
    },
  },
  {
    name: "another provider's grant id",
    refuses: ["pinGrant returns null", "loadEvidence returns null"],
    async arrange(seed, held) {
      // The other provider has a healthy grant of its own in the same workspace, so only the id is foreign.
      const foreign = await seedFounderRead(otherProvider(seed.provider), { on: seed });
      return { ...held, ref: { ...held.ref, provider: foreign.provider } };
    },
  },
  {
    name: "another provider's receipt id",
    refuses: ["loadEvidence returns null", "completedReceipts does not select the receipt"],
    async arrange(seed, held) {
      const foreign = await seedFounderRead(otherProvider(seed.provider), { on: seed });
      return { ...held, ref: { ...held.ref, receiptId: foreign.receiptId } };
    },
  },
  {
    name: "a stale grantRevision",
    refuses: ["loadEvidence returns null", "grantFence selects no row", "completedReceipts does not select the receipt"],
    arrange(_seed, held) {
      return { ...held, ref: { ...held.ref, grantRevision: held.pin.revision + 1 }, pin: { ...held.pin, revision: held.pin.revision + 1 } };
    },
  },
  {
    name: "an expired receipt",
    refuses: ["loadEvidence returns null", "completedReceipts does not select the receipt", "the evidence fence selects no row"],
    arrange(seed, held) {
      seed.db.prepare(`UPDATE ${seed.spec.receipts} SET expires_at=? WHERE id=?`).run(Date.now() - 1, seed.receiptId);
      return held;
    },
  },
  {
    name: "tampered report_json (the digest no longer matches)",
    refuses: ["loadEvidence returns null", "the evidence fence selects no row"],
    arrange(seed, held) {
      seed.db.prepare(`UPDATE ${seed.spec.receipts} SET report_json=report_json||' ' WHERE id=?`).run(seed.receiptId);
      return held;
    },
  },
  {
    name: "a revoked grant",
    refuses: ["pinGrant returns null", "loadEvidence returns null", "grantFence selects no row", "completedReceipts does not select the receipt", "the evidence fence selects no row"],
    async arrange(seed, held) {
      expect((await seed.call("POST", `/${seed.grantId}/revoke`, seed.decision(seed.digest)))?.status).toBe(200);
      return held;
    },
  },
  {
    name: "a receipt belonging to another grant",
    refuses: ["loadEvidence returns null", "completedReceipts does not select the receipt"],
    async arrange(seed, held) {
      const second = await seedFounderRead(seed.provider, { on: seed });
      expect(second.grantId).not.toBe(seed.grantId);
      return { ...held, ref: { ...held.ref, receiptId: second.receiptId } };
    },
  },
  {
    name: "a report whose capture selection differs from the grant's selection",
    only: ["hubspot", "meta"],
    refuses: ["loadEvidence returns null"],
    async arrange(seed, held) {
      // Re-digest the changed report so only the selection binding, not the digest check, can refuse it.
      const stored = seed.receipts()[0]!;
      expect(await seed.reads.sha256Json(stored.report_json!)).toBe(stored.result_digest);
      const report = JSON.parse(stored.report_json!) as { capture: { selection: unknown } };
      expect(JSON.stringify(report.capture.selection)).toBe(seed.grant().selection_json);
      report.capture.selection = seed.spec.otherSelection;
      const reportJson = JSON.stringify(report);
      seed.db.prepare(`UPDATE ${seed.spec.receipts} SET report_json=?,result_digest=? WHERE id=?`).run(reportJson, await seed.reads.sha256Json(reportJson), seed.receiptId);
      return held;
    },
  },
];

describe.each(READ_PROVIDERS)("founder reads evidence: %s", (provider) => {
  describe("issued for a completed read", () => {
    it("pins the enabled grant for its owner", async () => {
      const seed = await seedFounderRead(provider);
      const pin = await seed.reads.pinGrant(seed.env, seed.member, { provider, grantId: seed.grantId, need: "serving" });
      const row = seed.grant();
      expect(pin).toMatchObject({
        v: 1, provider, grantId: seed.grantId, revision: row.revision, workspaceId: seed.member.workspaceId, ownerId: seed.member.userId, ownerAccountId: seed.member.accountId,
        ownerJson: row.owner_json, accountId: row.account_id, contractDigest: seed.digest, executorDigest: row.executor_digest, selectionJson: row.selection_json, expiresAt: row.expires_at, maxCalls: row.max_calls,
      });
    });

    it("pins exactly the scope and verified facts of the grant", async () => {
      const seed = await seedFounderRead(provider);
      const pin = await seed.reads.pinGrant(seed.env, seed.member, { provider, grantId: seed.grantId, need: "serving" });
      expect(pin!.facts).toEqual({ stripe: { mode: "test" }, hubspot: { currency: "USD", timezoneName: "UTC" }, meta: { currency: "USD", timezoneName: "America/New_York" } }[provider]);
      expect(pin!.fingerprint).toBe(seed.grant().fingerprint);
    });

    it("never puts the ciphertext or the credential in a GrantPin", async () => {
      const seed = await seedFounderRead(provider);
      const pin = await seed.reads.pinGrant(seed.env, seed.member, { provider, grantId: seed.grantId, need: "serving" });
      const text = JSON.stringify(pin);
      expect(seed.grant().ciphertext.length).toBeGreaterThan(16);
      expect(text).not.toContain(seed.grant().ciphertext);
      expect(text).not.toContain(seed.spec.token);
      expect(Object.keys(pin!).filter((key) => /cipher|secret|token|key/i.test(key))).toEqual([]);
    });

    it("never puts the ciphertext or the credential in Evidence or its fence values", async () => {
      const seed = await seedFounderRead(provider);
      const { evidence } = await hold(seed);
      const text = JSON.stringify(evidence);
      expect(text).not.toContain(seed.grant().ciphertext);
      expect(text).not.toContain(seed.spec.token);
    });

    it("grantFence holds for serving and for capacity while calls remain", async () => {
      const seed = await seedFounderRead(provider);
      const { pin } = await hold(seed);
      expect(seed.holds(seed.reads.grantFence(pin, "serving"))).toBe(true);
      expect(seed.holds(seed.reads.grantFence(pin, "capacity"))).toBe(true);
    });

    it("completedReceipts selects exactly the grant's completed receipt", async () => {
      const seed = await seedFounderRead(provider);
      const { pin } = await hold(seed);
      expect(seed.selected(seed.reads.completedReceipts(pin))).toEqual([seed.receiptId]);
    });

    it("loadEvidence returns the stored receipt bound to the pin, with a fence that holds", async () => {
      const seed = await seedFounderRead(provider);
      const { pin, evidence } = await hold(seed);
      const stored = seed.receipts()[0]!;
      expect(evidence.pin).toEqual(pin);
      expect(evidence.receipt).toEqual({ id: seed.receiptId, createdAt: stored.created_at, expiresAt: stored.expires_at, resultDigest: stored.result_digest, reportJson: stored.report_json });
      expect(evidence.report).toEqual(JSON.parse(stored.report_json!));
      expect(evidence.selection).toEqual(JSON.parse(seed.grant().selection_json));
      expect(evidence.expiresAt).toBe(Math.min(pin.expiresAt, stored.expires_at));
      expect(seed.holds(evidence.fence)).toBe(true);
    });

    it("accepts the current grantRevision", async () => {
      const seed = await seedFounderRead(provider);
      const { pin, ref } = await hold(seed);
      expect(await seed.reads.loadEvidence(seed.env, seed.member, { ...ref, grantRevision: pin.revision })).not.toBeNull();
    });

    it("keeps serving an exhausted grant but refuses to pin it for capacity", async () => {
      const seed = await seedFounderRead(provider, { maxCalls: 2 });
      expect(seed.grant().state).toBe("exhausted");
      const { pin } = await hold(seed);
      expect(await seed.reads.pinGrant(seed.env, seed.member, { provider, grantId: seed.grantId, need: "capacity" })).toBeNull();
      expect(seed.holds(seed.reads.grantFence(pin, "capacity"))).toBe(false);
      expect(seed.holds(seed.reads.grantFence(pin, "serving"))).toBe(true);
    });
  });

  describe.each(refusals.filter((refusal) => !refusal.only || refusal.only.includes(provider)))("refused for $name", ({ refuses, arrange }) => {
    it.each(refuses)("%s", async (probe) => {
      const seed = await seedFounderRead(provider);
      const asked = await arrange(seed, await hold(seed));
      await probes[probe](seed, asked);
    });
  });
});
