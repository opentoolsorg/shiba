import { describe, expect, it, vi } from "vitest";
import { READ_PROVIDER_FIXTURES, READ_PROVIDERS, seedFounderRead, type FounderReadSeed } from "./fixtures/founder-read.js";

/**
 * D7. The lifecycle behaviours that used to be written once per provider (the founder-<provider>-lifecycle,
 * -routes and .security-v3/-v4 suites), stated once and run for every provider through the module's interface.
 * Faults are injected at the provider (`respond`, `onRead`) or at a tagged engine statement (`tap`).
 */
const HOUR = 3600000, DAY = 86400000;
const reportPath = (seed: FounderReadSeed) => `/${seed.grantId}/reports/${seed.receiptId}`;
const readCalls = (seed: FounderReadSeed) => seed.fetcher.mock.calls.filter(([url]) => !seed.spec.isVerify(String(url))).length;
const deleteSession = (seed: FounderReadSeed) => { seed.db.prepare(`DELETE FROM "session" WHERE id=?`).run(seed.sessionId); };
const storeSessionExpiry = (seed: FounderReadSeed, expiresAt: number | string) => { seed.db.prepare(`UPDATE "session" SET expiresAt=? WHERE id=?`).run(expiresAt, seed.sessionId); };
const clockAt = (ms: number) => { vi.spyOn(Date, "now").mockReturnValue(ms); };
const lost = () => { throw new Error("fixture: provider outcome unknown"); };
/**
 * A provider answer with a valid body under `status`. A real 204 cannot carry a body, and an empty body is refused by
 * the parser whatever the status says, so for 204 the status is overridden on a full response: only the status check can refuse it.
 */
const answered = (body: unknown, status: number) => status === 204
  ? Object.defineProperty(Response.json(body), "status", { value: status })
  : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The timezone each provider's default verification answer reports (stripe has no verified facts). */
const VERIFIED_ZONE = { hubspot: "UTC", meta: "America/New_York" } as const;

describe.each(READ_PROVIDERS)("founder reads lifecycle: %s", (provider) => {
  describe("availability", () => {
    it("refuses a new draft while the provider's reads are switched off", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      (seed.env as unknown as Record<string, string>)[`FOUNDER_${provider.toUpperCase()}_READS_ENABLED`] = "false";
      const response = await seed.call("POST", "", seed.draftBody());
      expect(response?.status).toBe(503);
      expect(await response!.json()).toMatchObject({ error: `${provider}_reads_unavailable` });
      expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
    });

    it("still lists the grant, marked unavailable, while reads are switched off", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      (seed.env as unknown as Record<string, string>)[`FOUNDER_${provider.toUpperCase()}_READS_ENABLED`] = "false";
      expect(await (await seed.call("GET"))!.json()).toMatchObject({ available: false, grants: [{ id: seed.grantId }] });
    });

    it("permits revoke while reads are switched off, erases the credential and never echoes it", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      (seed.env as unknown as Record<string, string>)[`FOUNDER_${provider.toUpperCase()}_READS_ENABLED`] = "false";
      const response = await seed.revoke();
      expect(response?.status).toBe(200);
      expect(await response!.text()).not.toContain(seed.spec.token);
      expect(seed.grant()).toMatchObject({ state: "revoked", ciphertext: "" });
    });
  });

  describe("verification", () => {
    it("refuses to enable a grant that was never verified", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      expect((await seed.enable())?.ok).toBe(false);
      expect(seed.grant()).toMatchObject({ state: "draft", next_due_at: null });
    });

    it("spends exactly one call on a successful verification", async () => {
      const seed = await seedFounderRead(provider, { until: "verified" });
      expect(seed.grant()).toMatchObject({ state: "verified", used_calls: 1 });
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    if (provider === "stripe") {
      it("keeps the reviewed digest through verification", async () => {
        const seed = await seedFounderRead(provider, { until: "draft" });
        const reviewed = seed.grant().contract_digest;
        expect((await seed.verify())?.status).toBe(200);
        expect(seed.grant().contract_digest).toBe(reviewed);
      });
    } else {
      it("freezes the verified currency and timezone into a new digest", async () => {
        const seed = await seedFounderRead(provider, { until: "draft" });
        const reviewed = seed.grant().contract_digest;
        expect(seed.grant()).toMatchObject({ currency: null, timezone_name: null });
        expect((await seed.verify())?.status).toBe(200);
        expect(seed.grant()).toMatchObject({ state: "verified", currency: "USD", timezone_name: VERIFIED_ZONE[provider] });
        expect(seed.grant().contract_digest).not.toBe(reviewed);
      });

      it("shows the owner exactly the currency and timezone the provider reported", async () => {
        const seed = await seedFounderRead(provider, { until: "verified" });
        const detail = await (await seed.call("GET", `/${seed.grantId}`))!.json() as { grant: Record<string, unknown> };
        expect(detail.grant).toMatchObject({ state: "verified", currency: "USD", timezoneName: VERIFIED_ZONE[provider] });
      });

      it("blocks a grant whose provider echoes the credential as a verified fact, and stores no fact", async () => {
        const seed = await seedFounderRead(provider, { until: "draft" });
        seed.respond("verify", () => Response.json({ ...seed.spec.verifyBody, [provider === "hubspot" ? "timeZone" : "timezone_name"]: seed.spec.token }));
        const response = await seed.verify();
        expect(response?.status).toBe(409);
        expect(await response!.text()).not.toContain(seed.spec.token);
        expect(seed.grant()).toMatchObject({ state: "blocked", currency: null, timezone_name: null, contract_digest: seed.digest });
      });

      it("refuses to enable with the digest reviewed before verification", async () => {
        const seed = await seedFounderRead(provider, { until: "draft" });
        const reviewed = seed.grant().contract_digest;
        await seed.verify();
        const response = await seed.call("POST", `/${seed.grantId}/enable`, seed.decision(reviewed));
        expect(response?.status).toBe(409);
        expect(seed.grant().state).toBe("verified");
      });
    }

    it("holds an unknown verification outcome: the call is spent, the grant is blocked and nothing is retried", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      seed.respond("verify", lost);
      const response = await seed.verify();
      expect(response?.status).toBe(409);
      expect(await response!.json()).toMatchObject({ error: `${provider}_verification_unconfirmed` });
      expect(seed.grant()).toMatchObject({ state: "blocked", used_calls: 1 });
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
      expect(seed.grant()).toMatchObject({ state: "blocked", used_calls: 1 });
    });

    it("lets the owner revoke a blocked grant while reads are switched off, keeping the spent call on record", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      seed.respond("verify", lost);
      await seed.verify();
      (seed.env as unknown as Record<string, string>)[`FOUNDER_${provider.toUpperCase()}_READS_ENABLED`] = "false";
      expect((await seed.revoke())?.status).toBe(200);
      expect(seed.grant()).toMatchObject({ state: "revoked", ciphertext: "", used_calls: 1 });
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    it("blocks a grant whose provider account is not the one drafted, before any read", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      seed.respond("verify", () => Response.json(seed.spec.wrongAccountBody));
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.grant()).toMatchObject({ state: "blocked", used_calls: 1 });
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
      expect((await seed.enable())?.ok).toBe(false);
      expect(readCalls(seed)).toBe(0);
    });

    it("does not call the provider when the reviewed executor pin no longer matches", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET executor_digest=? WHERE id=?`).run("0".repeat(64), seed.grantId);
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().used_calls).toBe(0);
    });

    it.each([204, 206, 207])("treats provider status %i as an unconfirmed account", async (status) => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      seed.respond("verify", () => answered(seed.spec.verifyBody, status));
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.grant().state).toBe("blocked");
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    it("rejects a provider answer that finishes after the grant expires", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      const expiresAt = seed.grant().expires_at;
      seed.respond("verify", () => { clockAt(expiresAt + 1); return Response.json(seed.spec.verifyBody); });
      expect((await seed.verify())?.ok).toBe(false);
      vi.restoreAllMocks();
      expect(seed.grant().state).toBe("blocked");
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    it("rejects a provider answer that finishes after the captured session expires", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      const captured = Date.now() + HOUR;
      seed.captureSessionUntil(captured);
      seed.respond("verify", () => { clockAt(captured + 1); return Response.json(seed.spec.verifyBody); });
      expect((await seed.verify())?.ok).toBe(false);
      vi.restoreAllMocks();
      expect(seed.grant().state).toBe("blocked");
      expect(seed.grant().contract_digest).toBe(seed.digest);
      if (provider !== "stripe") expect(seed.grant().currency).toBeNull();
    });

    it.each([
      ["the grant", (seed: FounderReadSeed) => seed.grant().expires_at],
      ["the session", (seed: FounderReadSeed) => { const lease = Date.now() + 60000; seed.captureSessionUntil(lease); storeSessionExpiry(seed, lease); return lease; }],
    ])("does not dispatch verification when the dispatch proof returns after %s lease has run out", async (_lease, arrange) => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      const lease = arrange(seed);
      const hook = seed.tap("after", "dispatch-proof", () => clockAt(lease + 1));
      expect((await seed.verify())?.ok).toBe(false);
      vi.restoreAllMocks();
      expect(hook.fired()).toBe(true);
      expect(seed.fetcher).not.toHaveBeenCalled();
    });
  });

  describe("human session on decisions", () => {
    it("reserves nothing for verification after the session row is deleted", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      deleteSession(seed);
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant()).toMatchObject({ state: "draft", used_calls: 0 });
    });

    it("reserves nothing for verification when the session disappears during the grant read", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      const hook = seed.tap("after", "grant-get", () => deleteSession(seed));
      expect((await seed.verify())?.ok).toBe(false);
      expect(hook.fired()).toBe(true);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant()).toMatchObject({ state: "draft", used_calls: 0 });
    });

    it("does not enable when the deciding session disappears during the grant read", async () => {
      const seed = await seedFounderRead(provider, { until: "verified" });
      const hook = seed.tap("after", "grant-get", () => deleteSession(seed));
      expect((await seed.enable())?.ok).toBe(false);
      expect(hook.fired()).toBe(true);
      expect(seed.grant()).toMatchObject({ state: "verified", next_due_at: null });
    });

    it("refuses verification when the stored session expiry is shorter than the captured one", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      storeSessionExpiry(seed, Date.now() + HOUR);
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant()).toMatchObject({ state: "draft", used_calls: 0 });
    });

    it("accepts a current session whose stored expiry is an ISO string", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      storeSessionExpiry(seed, new Date(Date.now() + 2 * DAY).toISOString());
      expect((await seed.call("POST", "", seed.draftBody()))?.status).toBe(201);
    });

    it("refuses a draft when the stored ISO session expiry is shorter than the captured one", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      storeSessionExpiry(seed, new Date(Date.now() + HOUR).toISOString());
      expect((await seed.call("POST", "", seed.draftBody()))?.ok).toBe(false);
      expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
    });

    it("does not let a re-versioned membership enable the original owner's grant", async () => {
      const seed = await seedFounderRead(provider, { until: "verified" });
      seed.db.prepare("UPDATE team_workspace_memberships SET version=version+1 WHERE workspace_id=? AND user_id=?").run(seed.member.workspaceId, seed.member.userId);
      seed.actAs({ ...seed.member, version: seed.member.version + 1 });
      expect((await seed.enable())?.ok).toBe(false);
      expect(seed.grant().state).toBe("verified");
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("scheduled tick", () => {
    it("exhausts the grant on its last call and never dispatches again", async () => {
      const seed = await seedFounderRead(provider, { maxCalls: 2 });
      expect(seed.grant()).toMatchObject({ state: "exhausted", used_calls: 2 });
      seed.fetcher.mockClear();
      expect((await seed.tick()).created).toBe(0);
      expect(seed.fetcher).not.toHaveBeenCalled();
    });

    it("does not block a grant whose missed window another tick already advanced", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1800000, seed.grantId);
      const advanced = Date.now() + DAY;
      const hook = seed.tap("after", "tick-due", () => { seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(advanced, seed.grantId); });
      seed.fetcher.mockClear();
      await seed.reads.tickFounderReads(seed.env, provider);
      expect(hook.fired()).toBe(true);
      await seed.reads.tickFounderReads(seed.env, provider);
      expect(seed.grant()).toMatchObject({ state: "enabled", next_due_at: advanced, used_calls: 1 });
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.receipts()).toHaveLength(0);
    });

    it("does not block a healthy grant when this tick loses the reservation to another", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const hook = seed.tap("before", "reserve", () => { seed.db.prepare(`UPDATE ${seed.spec.grants} SET state='running',used_calls=used_calls+1 WHERE id=?`).run(seed.grantId); });
      seed.fetcher.mockClear();
      expect((await seed.tick()).created).toBe(0);
      expect(hook.fired()).toBe(true);
      expect(seed.grant()).toMatchObject({ state: "running", used_calls: 2 });
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.receipts()).toHaveLength(0);
    });

    it("lets two concurrent ticks produce one receipt and leaves the grant healthy", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1000, seed.grantId);
      seed.fetcher.mockClear();
      const results = await Promise.all([seed.reads.tickFounderReads(seed.env, provider), seed.reads.tickFounderReads(seed.env, provider)]);
      expect(results.map((result) => result.created).sort()).toEqual([0, 1]);
      expect(seed.grant()).toMatchObject({ state: "enabled", used_calls: 2 });
      expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["completed"]);
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    it("spends one call across competing ticks and never retries an unknown outcome", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1000, seed.grantId);
      seed.respond("read", lost);
      seed.fetcher.mockClear();
      await Promise.all([seed.reads.tickFounderReads(seed.env, provider), seed.reads.tickFounderReads(seed.env, provider)]);
      await seed.tick();
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
      expect(seed.grant()).toMatchObject({ state: "blocked", used_calls: 2 });
      expect(seed.receipts().map(({ state, report_json }) => ({ state, report_json }))).toEqual([{ state: "unknown", report_json: null }]);
    });

    it("leaves a reserved running request alone", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET state='running',used_calls=2 WHERE id=?`).run(seed.grantId);
      seed.fetcher.mockClear();
      expect((await seed.tick()).created).toBe(0);
      expect(seed.grant().state).toBe("running");
      expect(seed.fetcher).not.toHaveBeenCalled();
    });

    it.each([204, 206, 207, 500])("holds provider status %i as an unknown outcome and never retries", async (status) => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      seed.respond("read", () => answered(seed.spec.readBody, status));
      seed.fetcher.mockClear();
      expect((await seed.tick()).created).toBe(1);
      expect(seed.receipts().map(({ state, report_json }) => ({ state, report_json }))).toEqual([{ state: "unknown", report_json: null }]);
      expect(seed.grant().state).toBe("blocked");
      await seed.tick();
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    it("never persists a credential the provider echoes back in a field the projection keeps", async () => {
      // Every field Meta's projection keeps is numeric, a currency or a date, so only an all-digit credential can be echoed through it.
      const spec = READ_PROVIDER_FIXTURES[provider], token = provider === "meta" ? "98765432109876543210" : spec.token;
      const seed = await seedFounderRead(provider, { until: "enabled", draft: { [spec.tokenField]: token } });
      seed.respond("read", () => Response.json(seed.spec.echoBody(token)));
      await seed.tick();
      expect(seed.fetcher.mock.calls.every(([, init]) => ((init as RequestInit).headers as Record<string, string>).authorization === `Bearer ${token}`)).toBe(true);
      expect(seed.receipts().map(({ state, report_json }) => ({ state, report_json }))).toEqual([{ state: "unknown", report_json: null }]);
      expect(seed.grant().state).toBe("blocked");
    });

    it("does not call the provider when revocation lands together with the reservation", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled", maxCalls: 2 });
      const hook = seed.tap("after", "reserve", async () => { expect((await seed.revoke())?.status).toBe(200); });
      seed.fetcher.mockClear();
      await seed.tick();
      expect(hook.fired()).toBe(true);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant()).toMatchObject({ state: "revoked", ciphertext: "", used_calls: 2 });
      expect(seed.receipts().map(({ state, report_json }) => ({ state, report_json }))).toEqual([{ state: "unknown", report_json: null }]);
    });

    it("publishes nothing and never retries when the owner revokes during the provider request", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      let revoked = 0;
      const hook = seed.onRead(async () => { revoked = (await seed.revoke())?.status ?? 0; });
      seed.fetcher.mockClear();
      await seed.tick();
      expect(hook.fired()).toBe(true);
      expect(revoked).toBe(200);
      expect(seed.receipts().map(({ state, report_json }) => ({ state, report_json }))).toEqual([{ state: "unknown", report_json: null }]);
      expect(seed.grant().state).toBe("revoked");
      expect((await seed.tick()).created).toBe(0);
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
    });

    it("does not dispatch when the dispatch proof returns after the grant has expired", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const expiresAt = seed.grant().expires_at;
      const hook = seed.tap("after", "dispatch-proof", () => clockAt(expiresAt + 1));
      seed.fetcher.mockClear();
      await seed.tick();
      vi.restoreAllMocks();
      expect(hook.fired()).toBe(true);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["unknown"]);
    });
  });

  describe("sealed credential", () => {
    // Two grants never share a scope, so this cannot see a constant nonce; founder-reads-internal-seal.test.ts seals one scope twice.
    it("seals two grants of the same credential to different ciphertexts, with one fingerprint", async () => {
      const first = await seedFounderRead(provider, { until: "draft" });
      const second = await seedFounderRead(provider, { on: first, until: "draft" });
      expect(second.grant().ciphertext).not.toBe(first.grant().ciphertext);
      expect(second.grant().fingerprint).toBe(first.grant().fingerprint);
    });

    it("does not spend a ciphertext transplanted from another grant of the same credential", async () => {
      const donor = await seedFounderRead(provider, { until: "enabled" });
      const seed = await seedFounderRead(provider, { on: donor, until: "enabled" });
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET ciphertext=? WHERE id=?`).run(donor.grant().ciphertext, seed.grantId);
      seed.fetcher.mockClear();
      await seed.tick();
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().state).toBe("blocked");
      expect(seed.receipts()).toHaveLength(0);
    });

    it("does not spend the credential under a different sealing key", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      (seed.env as unknown as Record<string, string>)[`FOUNDER_${provider.toUpperCase()}_CREDENTIAL_KEY`] = "6e".repeat(32);
      seed.fetcher.mockClear();
      await seed.tick();
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().state).toBe("blocked");
    });

    it("refuses verification of a ciphertext whose authentication tag was altered", async () => {
      const seed = await seedFounderRead(provider, { until: "draft" });
      const parts = seed.grant().ciphertext.split("."), tag = Buffer.from(parts.at(-1)!, "base64url");
      tag[tag.length - 1]! ^= 1;
      seed.db.prepare(`UPDATE ${seed.spec.grants} SET ciphertext=? WHERE id=?`).run([...parts.slice(0, -1), tag.toString("base64url")].join("."), seed.grantId);
      expect((await seed.verify())?.ok).toBe(false);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.grant().used_calls).toBe(0);
    });
  });

  describe("report route proofs", () => {
    it("withholds the report when the session disappears during the report read", async () => {
      const seed = await seedFounderRead(provider);
      const hook = seed.tap("after", "report", () => deleteSession(seed));
      const response = await seed.call("GET", reportPath(seed));
      expect(hook.fired()).toBe(true);
      expect(response?.status).toBe(403);
      expect(await response!.text()).not.toContain(seed.spec.reportMarker);
    });

    it("withholds the grant list when the session disappears during the list read", async () => {
      const seed = await seedFounderRead(provider);
      const hook = seed.tap("after", "grant-list", () => deleteSession(seed));
      const response = await seed.call("GET");
      expect(hook.fired()).toBe(true);
      expect(response?.status).toBe(403);
      expect(await response!.text()).not.toContain(seed.grantId);
    });

    it("withholds the report when the grant is revoked just before the final session proof", async () => {
      const seed = await seedFounderRead(provider);
      const hook = seed.tap("before", "session-proof", () => { seed.db.prepare(`UPDATE ${seed.spec.grants} SET state='revoked',ciphertext='' WHERE id=?`).run(seed.grantId); });
      const response = await seed.call("GET", reportPath(seed));
      expect(hook.fired()).toBe(true);
      expect(response?.status).toBe(403);
      expect(await response!.text()).not.toContain(seed.spec.reportMarker);
    });

    it.each([
      ["the grant", (seed: FounderReadSeed) => seed.grant().expires_at],
      ["the receipt", (seed: FounderReadSeed) => { const lease = Date.now() + HOUR; seed.db.prepare(`UPDATE ${seed.spec.receipts} SET expires_at=? WHERE id=?`).run(lease, seed.receiptId); return lease; }],
      // Captured and stored expiry move together: a stored expiry shorter than the captured one is refused by the session fence, whatever the clock says.
      ["the session", (seed: FounderReadSeed) => { const lease = Date.now() + 60000; seed.captureSessionUntil(lease); storeSessionExpiry(seed, lease); return lease; }],
    ])("withholds the report when the final proof returns after %s lease has run out", async (_lease, arrange) => {
      const seed = await seedFounderRead(provider);
      const lease = arrange(seed);
      // Control: with the lease arranged but still running, the same request is served, so only the clock passing it refuses below.
      expect((await seed.call("GET", reportPath(seed)))?.status).toBe(200);
      const hook = seed.tap("after", "session-proof", () => clockAt(lease + 1));
      const response = await seed.call("GET", reportPath(seed));
      vi.restoreAllMocks();
      expect(hook.fired()).toBe(true);
      expect(response?.status).toBe(403);
      const text = await response!.text();
      expect(JSON.parse(text)).toMatchObject({ error: `${provider}_native_session_required` });
      expect(text).not.toContain(seed.spec.reportMarker);
    });

    it("does not serve the report again after the owner is removed from the workspace and re-added", async () => {
      const seed = await seedFounderRead(provider);
      expect((await seed.call("GET", reportPath(seed)))?.status).toBe(200);
      const membership = "UPDATE team_workspace_memberships SET status=?,version=version+1 WHERE workspace_id=? AND user_id=?";
      seed.db.prepare(membership).run("removed", seed.member.workspaceId, seed.member.userId);
      seed.db.prepare(membership).run("active", seed.member.workspaceId, seed.member.userId);
      seed.actAs({ ...seed.member, version: seed.member.version + 2 });
      const response = await seed.call("GET", reportPath(seed));
      expect(response?.status).toBe(404);
      const text = await response!.text();
      expect(JSON.parse(text)).toMatchObject({ error: `${provider}_report_unavailable` });
      expect(text).not.toContain(seed.spec.reportMarker);
    });
  });
});
