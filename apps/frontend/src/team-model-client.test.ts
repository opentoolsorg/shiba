import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamModelClient, TeamModelRequestError } from "./team-model-client";
import { teamModelFixture, TEAM_MODEL_ACTOR, TEAM_MODEL_OPERATOR, TEAM_MODEL_ROOM, TEAM_MODEL_WORKSPACE } from "./team-model-fixtures";
import { teamModelPriceQuoteDigest } from "@shiba/shared";
const signal = () => new AbortController().signal;
const client = (fetcher: typeof fetch, actor = TEAM_MODEL_ACTOR) => new TeamModelClient(TEAM_MODEL_WORKSPACE, TEAM_MODEL_ROOM, actor, fetcher);
const fundingResponse = (grant = teamModelFixture().grant) => ({ ok: true, workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, grant });
const turnResponse = (turn = teamModelFixture().turn) => ({ ok: true, workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, turn });
const errorFrom = async (operation: Promise<unknown>) => { const error = await operation.catch((cause: unknown) => cause); expect(error).toBeInstanceOf(Error); return error as Error; };
afterEach(() => vi.unstubAllGlobals());

describe("team model exact scoped client", () => {
  it.each(["budget", "quote rate", "quote digest", "currency"])("rejects a changed %s in the prepared billing contract", async (changed) => {
    const { grant } = teamModelFixture(); grant.state = "draft";
    const { roomId: _room, issuerId: _issuer, employeeName: _name, employeeInstructions: _instructions, billing: _billing, audience: _audience, tools: _tools, credentialRef: _credential, money: _money, ...base } = grant.contract;
    const input = { ...base, currency: "USD" as const, budgetMicroUsd: 100_000 };
    const body = JSON.parse(JSON.stringify(grant));
    if (changed === "budget") body.contract.money.budgetMicroUsd++;
    if (changed === "quote rate") body.contract.money.quote.outputMicroUsdPerMillionTokens = 1;
    if (changed === "quote digest") body.contract.money.quote.digest = "0".repeat(64);
    if (changed === "currency") body.contract.money.currency = "EUR";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fundingResponse(body)));
    expect((await errorFrom(client(fetcher, TEAM_MODEL_OPERATOR).prepareFunding(input, signal()))).message).toMatch(/verified/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses expired price reviews or amountless activation and execution before HTTP", async () => {
    const { grant, turn } = teamModelFixture(), fetcher = vi.fn<typeof fetch>();
    const { digest: _digest, ...quote } = { ...grant.contract.money!.quote, createdAt: Date.now() - 900_001, dispatchUntil: Date.now() - 1 };
    grant.contract.money!.quote = { ...quote, digest: teamModelPriceQuoteDigest(quote) };
    await errorFrom(client(fetcher).activateFunding(grant, signal()));
    turn.cost!.dispatchUntil = quote.dispatchUntil; await errorFrom(client(fetcher).executeTurn(turn, signal()));
    delete grant.contract.money; await errorFrom(client(fetcher).activateFunding(grant, signal()));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("mount state reads use an exact room and workspace without starting effects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(teamModelFixture().state)), c = client(fetcher), abort = signal();
    expect(fetcher).not.toHaveBeenCalled(); await c.state(abort);
    expect(fetcher).toHaveBeenCalledWith(`/api/team-model-sessions/state?roomId=${TEAM_MODEL_ROOM}`, expect.objectContaining({ method: "GET", signal: abort, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Shiba-Workspace": TEAM_MODEL_WORKSPACE } }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves the native fetch receiver", async () => {
    vi.stubGlobal("fetch", function (this: unknown) { if (this !== globalThis) throw new TypeError("Illegal invocation"); return Promise.resolve(Response.json(teamModelFixture().state)); });
    await new TeamModelClient(TEAM_MODEL_WORKSPACE, TEAM_MODEL_ROOM, TEAM_MODEL_ACTOR).state(signal());
  });
  it.each(["workspace", "room", "actor", "turn-owner"])("rejects a foreign %s state", async (variant) => {
    const body = teamModelFixture().state;
    if (variant === "workspace") body.workspaceId = `ws_${"b".repeat(24)}`;
    if (variant === "room") body.roomId = `room_${"c".repeat(24)}`;
    if (variant === "actor") body.actorId = TEAM_MODEL_OPERATOR;
    if (variant === "turn-owner") body.turns = [{ ...teamModelFixture().turn, requesterId: TEAM_MODEL_OPERATOR }];
    const error = await errorFrom(client(vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))).state(signal()));
    expect(error.message).toMatch(/another/);
  });
  it("prepares exact funding without activating it and rejects changed member versions", async () => {
    const { grant } = teamModelFixture(); grant.state = "draft"; grant.canActivate = true; grant.contract.issuerId = TEAM_MODEL_OPERATOR;
    const { roomId: _, issuerId: _issuer, employeeName: _name, employeeInstructions: _instructions, billing: _billing, audience: _audience, tools: _tools, credentialRef: _credential, money: _money, ...base } = grant.contract;
    const input = { ...base, currency: "USD" as const, budgetMicroUsd: grant.contract.money!.budgetMicroUsd };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fundingResponse(grant))).mockResolvedValueOnce(Response.json(fundingResponse({ ...grant, contract: { ...grant.contract, memberVersion: 999 } })));
    await client(fetcher, TEAM_MODEL_OPERATOR).prepareFunding(input, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ roomId: TEAM_MODEL_ROOM, ...input });
    expect((await errorFrom(client(fetcher, TEAM_MODEL_OPERATOR).prepareFunding(input, signal()))).message).toContain("exact funding contract");
    expect(fetcher.mock.calls.every(([path]) => String(path).endsWith("/funding/prepare"))).toBe(true);
  });
  it("activation binds billing consent, digest and version, and does not execute turns", async () => {
    const { grant } = teamModelFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fundingResponse({ ...grant, version: 3 })));
    await client(fetcher).activateFunding(grant, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ expectedVersion: 2, digest: grant.digest, billingConsent: true, reviewed: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["grant", "model", "prompt", "extra-source", "note-hash"])("rejects changed %s from turn preparation", async (variant) => {
    const { grant, turn } = teamModelFixture();
    const note = { id: "ctx_note", version: 1 as const, sha256: "a".repeat(64) };
    turn.sources = [{ ...note, kind: "note", author: TEAM_MODEL_ACTOR, body: "Selected note." }];
    if (variant === "grant") turn.grantId = "another-grant";
    if (variant === "model") turn.model = "unfunded-model";
    if (variant === "prompt") turn.requestedPrompt = "Another prompt";
    if (variant === "extra-source") turn.sources.push({ kind: "message", id: "hidden-message", author: "other", body: "Not selected", version: null, sha256: "b".repeat(64) });
    if (variant === "note-hash") turn.sources[0]!.sha256 = "b".repeat(64);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(turnResponse(turn)));
    expect((await errorFrom(client(fetcher).prepareTurn(grant, { prompt: "Write a short fixture summary.", messageIds: [], memoryRefs: [note], requestId: crypto.randomUUID() }, signal()))).message).toContain("exact prompt, model and source");
  });
  it("approval, execution and stop are separate exact version-bound calls", async () => {
    const { turn } = teamModelFixture();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(turnResponse({ ...turn, version: 2 })));
    const c = client(fetcher); await c.approveTurn(turn, signal()); await c.executeTurn(turn, signal()); await c.cancelTurn(turn, signal());
    expect(fetcher.mock.calls.map(([path]) => String(path).split("/").at(-1))).toEqual(["approve", "execute", "cancel"]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ expectedVersion: 1, inputHash: turn.inputHash, reviewed: true });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ expectedVersion: 1, inputHash: turn.inputHash });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ expectedVersion: 1 });
  });
  it("rejects a mismatched execute receipt without retry", async () => {
    const { turn } = teamModelFixture(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(turnResponse({ ...turn, inputHash: "0".repeat(64) })));
    expect((await errorFrom(client(fetcher).executeTurn(turn, signal()))).message).toContain("exact team model turn receipt");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not expose raw denial errors or accept late aborted responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "fixture secret must not render" }, { status: 403 }));
    const denied = await errorFrom(client(fetcher).state(signal())); expect(denied).toBeInstanceOf(TeamModelRequestError); expect(denied.message).not.toContain("fixture secret");
    const abort = new AbortController(); fetcher.mockImplementation(async () => { abort.abort(); return Response.json(teamModelFixture().state); });
    await errorFrom(client(fetcher).state(abort.signal));
  });
});
