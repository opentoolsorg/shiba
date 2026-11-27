import { describe, expect, it } from "vitest";
import { READ_PROVIDER_FIXTURES, READ_PROVIDERS, seedFounderRead, type FounderReadSeed } from "./fixtures/founder-read.js";

type Wire = Record<string, any>;
const json = async (response: Response | null) => await response!.json() as Wire;

describe.each(READ_PROVIDERS)("founder reads interface: %s", (provider) => {
  const others = READ_PROVIDERS.filter((other) => other !== provider);

  describe("happy path", () => {
    it("never returns the credential while a grant is drafted, verified and enabled", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      expect(seed.wire).toHaveLength(3);
      expect(seed.wire.join("\n")).not.toContain(seed.spec.token);
    });

    it("stores the credential sealed, not in the clear", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      expect(seed.grant().ciphertext).not.toBe("");
      expect(JSON.stringify(seed.grant())).not.toContain(seed.spec.token);
    });

    it("enables a verified grant that is scoped to the workspace and actor", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const detail = await json(await seed.call("GET", `/${seed.grantId}`));
      expect(detail).toMatchObject({ workspaceId: seed.member.workspaceId, actorId: seed.member.userId, grant: { id: seed.grantId, state: "enabled", digest: seed.digest, usedCalls: 1 }, receipts: [] });
    });

    it("records one completed receipt when the scheduled tick runs a due grant", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      expect(await seed.tick()).toEqual({ created: 1, unavailable: false });
      expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["completed"]);
      expect(seed.grant()).toMatchObject({ state: "enabled", used_calls: 2 });
    });

    it("keeps the credential out of the stored report", async () => {
      const seed = await seedFounderRead(provider);
      const receipt = seed.receipts()[0]!;
      expect(receipt.report_json).toContain(seed.spec.reportMarker);
      expect(receipt.report_json).not.toContain(seed.spec.token);
    });

    it("lists the owner's grant", async () => {
      const seed = await seedFounderRead(provider);
      const list = await seed.call("GET");
      expect(list?.status).toBe(200);
      expect(await json(list)).toMatchObject({ available: true, grants: [{ id: seed.grantId, state: "enabled" }] });
    });

    it("shows the receipt on the grant detail", async () => {
      const seed = await seedFounderRead(provider);
      const detail = await json(await seed.call("GET", `/${seed.grantId}`));
      expect(detail.receipts).toMatchObject([{ id: seed.receiptId, state: "completed" }]);
    });

    it("serves the report with the digest of the stored bytes", async () => {
      const seed = await seedFounderRead(provider);
      const response = await seed.call("GET", `/${seed.grantId}/reports/${seed.receiptId}`);
      expect(response?.status).toBe(200);
      const body = await json(response);
      const receipt = seed.receipts()[0]!;
      expect(body.digest).toBe(receipt.result_digest);
      expect(body.report).toEqual(JSON.parse(receipt.report_json!));
      expect(body.report).toMatchObject({ grantId: seed.grantId, contractDigest: seed.digest });
    });

    it("revokes the grant and erases the sealed credential", async () => {
      const seed = await seedFounderRead(provider);
      expect((await seed.call("POST", `/${seed.grantId}/revoke`, seed.decision(seed.digest)))?.status).toBe(200);
      expect(seed.grant()).toMatchObject({ state: "revoked", ciphertext: "" });
    });
  });

  describe("session gate", () => {
    const routes: [string, (seed: FounderReadSeed) => Promise<Response | null>, (seed: FounderReadSeed, headers: Record<string, string | null>) => Promise<Response | null>][] = [
      ["GET list", (s) => s.call("GET"), (s, h) => s.call("GET", "", undefined, h)],
      ["GET detail", (s) => s.call("GET", `/${s.grantId}`), (s, h) => s.call("GET", `/${s.grantId}`, undefined, h)],
      ["GET report", (s) => s.call("GET", `/${s.grantId}/reports/${s.receiptId}`), (s, h) => s.call("GET", `/${s.grantId}/reports/${s.receiptId}`, undefined, h)],
      ["POST draft", (s) => s.call("POST", "", s.draftBody()), (s, h) => s.call("POST", "", s.draftBody(), h)],
      ["POST revoke", (s) => s.call("POST", `/${s.grantId}/revoke`, s.decision(s.digest)), (s, h) => s.call("POST", `/${s.grantId}/revoke`, s.decision(s.digest), h)],
    ];
    const withoutSession: [string, Record<string, string | null>][] = [
      ["no cookie", { cookie: null }],
      ["an authorization header", { authorization: "Bearer fixture" }],
    ];

    describe.each(routes)("%s", (_route, _withSession, send) => {
      it.each(withoutSession)("is refused with %s and changes nothing", async (_case, headers) => {
        const seed = await seedFounderRead(provider);
        const before = { grants: seed.db.prepare(`SELECT * FROM ${seed.spec.grants} ORDER BY id`).all(), receipts: seed.receipts() };
        const response = await send(seed, headers);
        expect(response?.status).toBe(403);
        const text = await response!.text();
        expect(text).toContain(`${provider}_native_session_required`);
        expect(text).not.toContain(seed.grantId);
        expect(text).not.toContain(seed.spec.reportMarker);
        expect({ grants: seed.db.prepare(`SELECT * FROM ${seed.spec.grants} ORDER BY id`).all(), receipts: seed.receipts() }).toEqual(before);
      });
    });

    // Draft-state decisions need their own seed state: verify acts on a draft, enable on a verified grant.
    it.each(withoutSession)("POST verify is refused with %s and spends no call", async (_case, headers) => {
      const seed = await seedFounderRead(provider);
      const draft = (await json(await seed.call("POST", "", seed.draftBody()))).grant as { id: string; digest: string };
      seed.fetcher.mockClear();
      const response = await seed.call("POST", `/${draft.id}/verify`, seed.decision(draft.digest), headers);
      expect(response?.status).toBe(403);
      expect(seed.fetcher).not.toHaveBeenCalled();
      expect(seed.db.prepare(`SELECT state,used_calls FROM ${seed.spec.grants} WHERE id=?`).get(draft.id)).toEqual({ state: "draft", used_calls: 0 });
    });

    it.each(withoutSession)("POST enable is refused with %s and leaves the grant verified", async (_case, headers) => {
      const seed = await seedFounderRead(provider);
      const draft = (await json(await seed.call("POST", "", seed.draftBody()))).grant as { id: string; digest: string };
      const verified = (await json(await seed.call("POST", `/${draft.id}/verify`, seed.decision(draft.digest)))).grant as { digest: string; state: string };
      expect(verified.state).toBe("verified");
      const response = await seed.call("POST", `/${draft.id}/enable`, seed.decision(verified.digest), headers);
      expect(response?.status).toBe(403);
      expect(seed.db.prepare(`SELECT state FROM ${seed.spec.grants} WHERE id=?`).get(draft.id)).toEqual({ state: "verified" });
    });

    it.each(routes)("%s succeeds with the cookie session (control for the refusals above)", async (_route, withSession) => {
      const seed = await seedFounderRead(provider);
      expect((await withSession(seed))?.ok).toBe(true);
    });

    it("refuses a human route once the session row is gone", async () => {
      const seed = await seedFounderRead(provider);
      seed.db.prepare(`DELETE FROM "session" WHERE id=?`).run(seed.sessionId);
      const response = await seed.call("GET", `/${seed.grantId}/reports/${seed.receiptId}`);
      expect(response?.status).toBe(403);
      const text = await response!.text();
      expect(text).toContain(`${provider}_native_session_required`);
      expect(text).not.toContain(seed.spec.reportMarker);
    });

    it.each([
      ["list", (s: FounderReadSeed) => s.call("GET")],
      ["detail", (s: FounderReadSeed) => s.call("GET", `/${s.grantId}`)],
    ])("withholds the grant %s once the session row is gone", async (_route, send) => {
      const seed = await seedFounderRead(provider);
      seed.db.prepare(`DELETE FROM "session" WHERE id=?`).run(seed.sessionId);
      const response = await send(seed);
      expect(response?.status).toBe(403);
      expect(await response!.text()).not.toContain(seed.grantId);
    });

    it("refuses a decision once the session row is gone", async () => {
      const seed = await seedFounderRead(provider);
      seed.db.prepare(`DELETE FROM "session" WHERE id=?`).run(seed.sessionId);
      const response = await seed.call("POST", `/${seed.grantId}/revoke`, seed.decision(seed.digest));
      expect(response?.ok).toBe(false);
      expect(seed.grant().state).toBe("enabled");
    });
  });

  // The fixture's request-auth stand-ins approve whoever `actAs` names, so the module's own role gate is exercised here.
  describe("manager gate", () => {
    it.each([
      ["GET report", (s: FounderReadSeed) => s.call("GET", `/${s.grantId}/reports/${s.receiptId}`)],
      ["POST revoke", (s: FounderReadSeed) => s.call("POST", `/${s.grantId}/revoke`, s.decision(s.digest))],
    ])("refuses %s from a workspace member who is not a manager", async (_route, send) => {
      const seed = await seedFounderRead(provider);
      seed.actAs({ ...seed.member, role: "member" });
      const response = await send(seed);
      expect(response?.status).toBe(403);
      const text = await response!.text();
      expect(JSON.parse(text)).toEqual({ error: `${provider}_native_manager_required` });
      expect(text).not.toContain(seed.spec.reportMarker);
      expect(seed.grant().state).toBe("enabled");
    });
  });

  describe("scheduled tick", () => {
    it("runs a due grant with no session row at all", async () => {
      const seed = await seedFounderRead(provider);
      seed.db.prepare(`DELETE FROM "session"`).run();
      seed.fetcher.mockClear();
      expect(await seed.tick()).toEqual({ created: 1, unavailable: false });
      expect(seed.fetcher).toHaveBeenCalledTimes(1);
      expect(seed.receipts().map((receipt) => receipt.state)).toEqual(["completed", "completed"]);
    });

    it("does not dispatch for a grant that is not due", async () => {
      const seed = await seedFounderRead(provider);
      seed.fetcher.mockClear();
      // The seeding tick moved next_due_at a day ahead; call the entry point without forcing it due.
      expect(await seed.reads.tickFounderReads(seed.env, provider)).toEqual({ created: 0, unavailable: false });
      expect(seed.fetcher).not.toHaveBeenCalled();
    });

    it("reports unavailable and dispatches nothing when the provider's reads are switched off", async () => {
      const seed = await seedFounderRead(provider);
      (seed.env as unknown as Record<string, string>)[`FOUNDER_${provider.toUpperCase()}_READS_ENABLED`] = "false";
      seed.fetcher.mockClear();
      expect(await seed.tick()).toEqual({ created: 0, unavailable: true });
      expect(seed.fetcher).not.toHaveBeenCalled();
    });
  });

  describe("provider isolation (D6)", () => {
    it.each(others)("does not find this provider's grant on the %s route", async (other) => {
      const seed = await seedFounderRead(provider);
      const foreign = await seedFounderRead(other, { on: seed });
      const response = await foreign.call("GET", `/${seed.grantId}`);
      expect(response === null || response.status === 404).toBe(true);
      expect(response ? await response.text() : "").not.toContain(seed.grantId);
    });

    it.each(others)("does not serve this provider's report on the %s route", async (other) => {
      const seed = await seedFounderRead(provider);
      const foreign = await seedFounderRead(other, { on: seed });
      for (const path of [`/${seed.grantId}/reports/${seed.receiptId}`, `/${foreign.grantId}/reports/${seed.receiptId}`, `/${seed.grantId}/reports/${foreign.receiptId}`]) {
        const response = await foreign.call("GET", path);
        expect(response === null || response.status === 404).toBe(true);
        expect(response ? await response.text() : "").not.toContain(seed.spec.reportMarker);
      }
    });

    it.each(others)("does not revoke this provider's grant through the %s route", async (other) => {
      const seed = await seedFounderRead(provider);
      const foreign = await seedFounderRead(other, { on: seed });
      const response = await foreign.call("POST", `/${seed.grantId}/revoke`, foreign.decision(seed.digest));
      expect(response === null || !response.ok).toBe(true);
      expect(seed.grant().state).toBe("enabled");
    });

    it.each(others)("leaves the %s grant untouched when this provider ticks", async (other) => {
      const seed = await seedFounderRead(provider);
      const foreign = await seedFounderRead(other, { on: seed });
      foreign.db.prepare(`UPDATE ${foreign.spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1000, foreign.grantId);
      await seed.tick();
      expect(foreign.receipts()).toHaveLength(1);
      expect(seed.receipts()).toHaveLength(2);
    });
  });

  describe("credential in the draft (D6)", () => {
    const leaks = READ_PROVIDER_FIXTURES[provider].leaks;

    // Stripe's table is empty: its account id and selection shapes cannot hold an `rk_` key, so no such draft exists.
    it.each(leaks)("rejects a draft whose $where contains the access token", async ({ token, draft }) => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const response = await seed.call("POST", "", seed.draftBody(draft, token));
      expect(response?.status).toBe(400);
      expect(await json(response)).toMatchObject({ error: `${provider}_selection_invalid` });
      expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
    });

    it.each(leaks)("accepts the same draft when the $where does not contain the token (control)", async ({ draft }) => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      expect((await seed.call("POST", "", seed.draftBody(draft)))?.status).toBe(201);
    });

    it("rejects a draft that puts the credential where the account id belongs", async () => {
      const seed = await seedFounderRead(provider, { until: "enabled" });
      const response = await seed.call("POST", "", seed.draftBody({ accountId: seed.spec.token }));
      expect(response?.status).toBe(400);
      expect(await response!.text()).not.toContain(seed.spec.token);
      expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
    });
  });
});
