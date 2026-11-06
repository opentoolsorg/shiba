import { describe, expect, it, vi } from "vitest";
import { PersonalExecutionClient, PersonalExecutionRequestError, currentPersonalAccounts, personalGrantAvailable } from "./personal-execution-client";
import { personalFixture, PERSONAL_ACTOR, PERSONAL_WORKSPACE } from "./personal-execution-fixtures";

describe("personal execution scoped client", () => {
  it("preserves the browser receiver for the native default fetch", async () => {
    const { computer } = personalFixture();
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ computers: [computer] }));
    });
    try { expect(await new PersonalExecutionClient(PERSONAL_WORKSPACE).computers(new AbortController().signal)).toEqual([computer]); }
    finally { vi.unstubAllGlobals(); }
  });
  it("uses only explicit workspace personal routes and same-origin noncached credentials", async () => {
    const { computer, grant } = personalFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ computers: [computer] })).mockResolvedValueOnce(Response.json({ grants: [grant] }));
    const client = new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher);
    const signal = new AbortController().signal;
    expect(await client.computers(signal)).toEqual([computer]); expect(await client.grants(signal)).toEqual([grant]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/personal-execution/computers", "/api/personal-execution/grants"]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ signal, credentials: "same-origin", cache: "no-store", headers: { "X-Shiba-Workspace": PERSONAL_WORKSPACE } });
    expect(() => new PersonalExecutionClient("personal")).toThrow("Select a team workspace");
  });
  it("never requests pairing until the caller explicitly invokes it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: "fixture-only", expiresAt: Date.now() + 60_000, connectCommand: "fixture connect" }));
    const client = new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher); expect(fetcher).not.toHaveBeenCalled();
    const selection = { harness: "codex" as const, accountFingerprint: "a".repeat(64) };
    await client.pair(selection, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith("/api/personal-execution/pairing-token", expect.objectContaining({ method: "POST", body: JSON.stringify(selection) }));
  });
  it("binds revocation to the exact expected grant version", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ revoked: true, version: 2 }));
    const { grant } = personalFixture();
    await new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher).revoke(grant, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith(`/api/personal-execution/grants/${grant.snapshot.grantId}`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expectedVersion: 1 }) }));
  });
  it("unpairs only the exact personal machine revision", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ revoked: true }));
    const { computer } = personalFixture();
    await new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher).unpair(computer, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith("/api/personal-execution/computers/machine-personal", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expectedRevision: 3 }) }));
  });
  it("aborts before requests and before accepting a late response", async () => {
    const abort = new AbortController(); abort.abort(); const fetcher = vi.fn<typeof fetch>();
    await expect(new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher).grants(abort.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const late = new AbortController();
    fetcher.mockImplementation(async () => { late.abort(); return Response.json({ grants: [] }); });
    await expect(new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher).grants(late.signal)).rejects.toThrow();
  });
  it("fails unavailable without exposing arbitrary error details or malformed proof", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: "fixture secret: do not display" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ grants: [{ snapshot: {} }] })).mockResolvedValueOnce(Response.json({ computers: [null] }));
    const client = new PersonalExecutionClient(PERSONAL_WORKSPACE, fetcher), signal = new AbortController().signal;
    await expect(client.grants(signal)).rejects.toBeInstanceOf(PersonalExecutionRequestError);
    const grantFailure = await client.grants(signal).catch((cause: unknown) => cause);
    expect(grantFailure).toBeInstanceOf(Error);
    expect((grantFailure as Error).message).toBe("The personal grant could not be verified.");
    const computerFailure = await client.computers(signal).catch((cause: unknown) => cause);
    expect(computerFailure).toBeInstanceOf(Error);
    expect((computerFailure as Error).message).toBe("Personal computers could not be verified.");
  });
  it.each(["offline", "expired", "stale-proof", "other-owner", "membership", "machine-version", "grant-version", "revoked", "unsupported-platform", "old-cli"])("refuses %s account or grant without substitution", (failure) => {
    const now = Date.now(), { computer, grant } = personalFixture(now);
    if (failure === "offline") computer.status = "offline";
    if (failure === "expired") grant.snapshot.expiresAt = now;
    if (failure === "stale-proof") computer.personalExecution!.accounts[0]!.receivedAt = now - 76_000;
    if (failure === "other-owner") computer.personalExecution!.scope.ownerAccountId = "another-owner";
    if (failure === "membership") computer.personalExecution!.scope.membershipVersion++;
    if (failure === "machine-version") computer.personalExecution!.revision++;
    if (failure === "grant-version") grant.version++;
    if (failure === "revoked") grant.status = "revoked";
    if (failure === "unsupported-platform") computer.platform = "win32-x64";
    if (failure === "old-cli") computer.personalExecution!.accounts[0]!.cliVersion = "0.1.0";
    expect(personalGrantAvailable(grant, [computer], PERSONAL_WORKSPACE, PERSONAL_ACTOR, now)).toBe(false);
  });
  it("accepts only fresh account evidence in the requesting actor/workspace", () => {
    const now = Date.now(), { computer, grant } = personalFixture(now);
    expect(personalGrantAvailable(grant, [computer], PERSONAL_WORKSPACE, PERSONAL_ACTOR, now)).toBe(true);
    expect(currentPersonalAccounts(computer, PERSONAL_WORKSPACE, "other@example.test", now)).toEqual([]);
    expect(currentPersonalAccounts(computer, "ws_" + "b".repeat(24), PERSONAL_ACTOR, now)).toEqual([]);
  });
});
