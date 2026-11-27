import { describe, expect, it } from "vitest";
import { READ_PROVIDER_FIXTURES, READ_PROVIDERS, seedFounderRead, type FounderReadSeed } from "./fixtures/founder-read.js";

/**
 * D4. Every column the exact-row predicate binds (reads/ledger.ts `exactGrantRow`, plus the
 * provider's scope and fact columns from the fixture table) is changed on its own, directly in
 * the database, and the module must then refuse to spend the credential or serve the report.
 *
 * Three moments are covered, because they are guarded by different statements:
 *  - at rest, before a human asks for the report and before the tick selects the grant;
 *  - at rest, on a late occurrence (the stale-skip path reschedules instead of dispatching);
 *  - in flight, while the provider request is open, so only the settle statement's predicate can refuse.
 */
const BASE_COLUMNS = ["revision", "contract_digest", "executor_digest", "owner_json", "selection_json", "account_id", "expires_at", "max_calls", "ciphertext"] as const;

function changed(seed: FounderReadSeed, column: string): string | number {
  const row = seed.grant();
  switch (column) {
    case "revision": return row.revision + 1;
    case "contract_digest": return "0".repeat(64);
    case "executor_digest": return "0".repeat(64);
    case "owner_json": return JSON.stringify({ ...JSON.parse(row.owner_json), role: "admin-changed" });
    case "selection_json": return JSON.stringify(seed.spec.otherSelection);
    case "account_id": return seed.spec.otherAccount;
    case "expires_at": return row.expires_at + 1000;
    case "max_calls": return row.max_calls + 1;
    case "ciphertext": {
      // A middle character, so the change never depends on how trailing base64url bits are treated.
      const at = row.ciphertext.length >> 1;
      return `${row.ciphertext.slice(0, at)}${row.ciphertext[at] === "A" ? "B" : "A"}${row.ciphertext.slice(at + 1)}`;
    }
    default: return seed.spec.extraColumns[column]!;
  }
}

function mutate(seed: FounderReadSeed, column: string) {
  const value = changed(seed, column);
  expect(value).not.toBe(seed.grant()[column]);
  const done = seed.db.prepare(`UPDATE ${seed.spec.grants} SET ${column}=? WHERE id=?`).run(value, seed.grantId);
  expect(done.changes).toBe(1);
}

const reportPath = (seed: FounderReadSeed) => `/${seed.grantId}/reports/${seed.receiptId}`;

describe.each(READ_PROVIDERS)("founder reads exact-row predicate: %s", (provider) => {
  const columns = [...BASE_COLUMNS, ...Object.keys(READ_PROVIDER_FIXTURES[provider].extraColumns)];

  it("serves the report and dispatches the next read while the row is untouched (control)", async () => {
    const seed = await seedFounderRead(provider);
    expect((await seed.call("GET", reportPath(seed)))?.status).toBe(200);
    seed.fetcher.mockClear();
    expect((await seed.tick()).created).toBe(1);
    expect(seed.fetcher).toHaveBeenCalledTimes(1);
    expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["completed", "completed"]);
  });

  describe.each(columns)("%s changed at rest", (column) => {
    // Ciphertext is left out by decision: serving a stored report does not use the credential, and its only
    // legitimate change is revoke, which is refused on state (see the revoke cases below).
    if (column !== "ciphertext") it("does not serve the report", async () => {
      const seed = await seedFounderRead(provider);
      mutate(seed, column);
      const response = await seed.call("GET", reportPath(seed));
      expect(response?.status).toBe(404);
      const text = await response!.text();
      expect(JSON.parse(text)).toMatchObject({ error: `${provider}_report_unavailable` });
      expect(text).not.toContain(seed.spec.reportMarker);
    });

    it("does not dispatch on the scheduled tick", async () => {
      const seed = await seedFounderRead(provider);
      mutate(seed, column);
      seed.fetcher.mockClear();
      await seed.tick();
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["completed"]);
    });

    // Ciphertext is left out here on purpose: at rest the row is compared with itself and the late path
    // does not open the credential, so only the contract digest can notice a change, and it does not
    // cover ciphertext. B1 (Stripe's narrower stale-skip fence) is only observable between the due-select
    // and the reschedule, which needs the D3 statement tags and is not reachable through the interface.
    if (column !== "ciphertext") it("does not reschedule a late occurrence as healthy", async () => {
      const seed = await seedFounderRead(provider);
      mutate(seed, column);
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1800000, seed.grantId);
      seed.fetcher.mockClear();
      await seed.reads.tickFounderReads(seed.env, provider);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().state).toBe("blocked");
    });
  });

  // Refused as a changed contract (digest and sealed scope), not by the account pattern: these stay refused if the pattern
  // is loosened. The pattern itself is isolated in founder-reads-internal-seal.test.ts.
  if (provider === "hubspot") describe.each(["0123", "1".repeat(17)])("account_id changed at rest to the non-canonical %s", (accountId) => {
    const change = (seed: FounderReadSeed) => expect(seed.db.prepare(`UPDATE ${seed.spec.grants} SET account_id=? WHERE id=?`).run(accountId, seed.grantId).changes).toBe(1);

    it("does not serve the report of the changed contract", async () => {
      const seed = await seedFounderRead(provider);
      change(seed);
      const response = await seed.call("GET", reportPath(seed));
      expect(response?.status).toBe(404);
      expect(await response!.text()).not.toContain(seed.spec.reportMarker);
    });

    it("does not dispatch for the changed contract, and blocks the grant", async () => {
      const seed = await seedFounderRead(provider);
      change(seed);
      seed.fetcher.mockClear();
      expect((await seed.tick()).created).toBe(0);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().state).toBe("blocked");
    });
  });

  describe("after revoke (ciphertext blanked, state revoked)", () => {
    const revoke = async (seed: FounderReadSeed) => {
      expect((await seed.call("POST", `/${seed.grantId}/revoke`, seed.decision(seed.digest)))?.status).toBe(200);
      expect(seed.grant()).toMatchObject({ state: "revoked", ciphertext: "" });
    };

    it("does not serve the report", async () => {
      const seed = await seedFounderRead(provider);
      await revoke(seed);
      const response = await seed.call("GET", reportPath(seed));
      expect(response?.status).toBe(404);
      const text = await response!.text();
      expect(JSON.parse(text)).toMatchObject({ error: `${provider}_report_unavailable` });
      expect(text).not.toContain(seed.spec.reportMarker);
    });

    it("does not dispatch on the scheduled tick", async () => {
      const seed = await seedFounderRead(provider);
      await revoke(seed);
      seed.fetcher.mockClear();
      expect((await seed.tick()).created).toBe(0);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["completed"]);
      expect(seed.grant().state).toBe("revoked");
    });
  });

  it("reschedules an untouched late occurrence without dispatching (control for the late case)", async () => {
    const seed = await seedFounderRead(provider);
    seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1800000, seed.grantId);
    seed.fetcher.mockClear();
    await seed.reads.tickFounderReads(seed.env, provider);
    expect(seed.fetcher).not.toHaveBeenCalled();
    expect(seed.grant().state).toBe("enabled");
    expect(seed.grant().next_due_at).toBeGreaterThan(Date.now());
  });

  // B1: the stale-skip must use the same exact-row predicate as every other statement.
  describe.each(columns)("%s changed between the tick's due-select and the stale-skip", (column) => {
    it("is not rescheduled as a healthy grant", async () => {
      const seed = await seedFounderRead(provider);
      const late = Date.now() - 1800000;
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(late, seed.grantId);
      const hook = seed.tap("after", "tick-due", () => mutate(seed, column));
      seed.fetcher.mockClear();
      await seed.reads.tickFounderReads(seed.env, provider);
      expect(hook.fired()).toBe(true);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().next_due_at).toBe(late);
      // Correct, not a gap: block is a compare-and-set on the row the tick read, so it must not block a revision it never validated; the next tick judges the new revision itself.
      expect(seed.grant().state).toBe(column === "revision" ? "enabled" : "blocked");
    });
  });

  describe.each(columns)("%s changed after the report route's final proof", (column) => {
    it("does not serve the report", async () => {
      const seed = await seedFounderRead(provider);
      const hook = seed.tap("after", "final-proof", () => mutate(seed, column));
      const response = await seed.call("GET", reportPath(seed));
      expect(hook.fired()).toBe(true);
      expect(response?.status).toBe(403);
      expect(await response!.text()).not.toContain(seed.spec.reportMarker);
    });
  });

  describe.each(columns)("%s changed while the provider request is in flight", (column) => {
    it("does not complete the receipt or serve its report", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const hook = seed.onRead(() => mutate(seed, column));
      seed.fetcher.mockClear();
      await seed.tick();
      expect(hook.fired()).toBe(true);
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
      const [receipt] = seed.receipts();
      expect(receipt).toMatchObject({ state: "unknown", report_json: null });
      expect(seed.grant().state).not.toBe("enabled");
      const response = await seed.call("GET", `/${seed.grantId}/reports/${receipt!.id}`);
      expect(response?.status).toBe(404);
      const text = await response!.text();
      expect(JSON.parse(text)).toMatchObject({ error: `${provider}_report_unavailable` });
      expect(text).not.toContain(seed.spec.reportMarker);
    });

    it("does not retry the read on the next tick", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const hook = seed.onRead(() => mutate(seed, column));
      await seed.tick();
      expect(hook.fired()).toBe(true);
      seed.fetcher.mockClear();
      await seed.tick();
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.receipts()).toHaveLength(1);
    });
  });
});
