import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { hash, digest } from "../src/json.js";
import { OPERATOR_INPUT_SCHEMA, operatorRequestDigest, parseOperatorEnvelope, parseOperatorJson, type OperatorExecutionEnvelope } from "../src/operator-envelope.js";
import { OperatorInvocationStore, type OperatorSqlStorage } from "../src/operator-store.js";
import { CoordinatedOwner, type CoordinatedD1, type CoordinatedD1Statement } from "../src/coordinated-owner.js";
import { OperatorGateway, type OperatorParentAuthority } from "../src/operator-gateway.js";
import { prepareOperatorFigmaRequest } from "../src/operator-provider.js";

class Storage implements OperatorSqlStorage {
  readonly db = new DatabaseSync(":memory:");
  syncHook: (() => Promise<void>) | undefined;
  readonly sql = { exec: <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> => this.db.prepare(query).all(...bindings as SQLInputValue[]) as T[] };
  transactionSync<T>(work: () => T): T { this.db.exec("BEGIN"); try { const value = work(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  async sync() { await this.syncHook?.(); }
}
const KEY = "figd_fixture_key_not_real_123456789", TOKEN = `oct_${"a".repeat(43)}`;
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function envelope(): Promise<OperatorExecutionEnvelope> {
  const input: OperatorExecutionEnvelope = {
    format: "shiba.operator-execute.v1", invocationId: "invocation-1", approvalId: "approval-1", requestDigest: "0".repeat(64),
    enrollmentId: "enrollment-1", enrollmentGeneration: 1, connectionId: `oco_${"a".repeat(64)}`, ownerId: "owner-1", personalAlias: `u_${(await digest("owner-1")).slice(0, 16)}`,
    provider: "figma", rawConnectionId: "raw-1", upstreamRevision: "revision-1", deploymentEpoch: "epoch-1", versionId: "11111111-1111-4111-8111-111111111111", manifestDigest: "b".repeat(64),
    principalId: "principal-1", employeeId: "employee-1", employeeVersion: 1, executionContextId: "context-1", grantVersions: [{ kind: "actor_grant", id: "grant-1", version: 1 }],
    actionId: "figma.get_file_metadata", inputSchemaHash: await hash(OPERATOR_INPUT_SCHEMA), arguments: { fileKey: "file123" }, argumentDigest: await hash({ fileKey: "file123" }), expiresAt: Date.now() + 30000, maxDurationMs: 1000, maxBytes: 4096,
  };
  input.requestDigest = await operatorRequestDigest(input); return input;
}
async function fixture() {
  const input = await envelope(), storage = new Storage(), store = new OperatorInvocationStore(storage), owner = new CoordinatedOwner();
  store.recover(); store.initializeEpoch(input.deploymentEpoch);
  let now = Date.now();
  const native = { revision: "revision-1", tokenActive: true, policyActive: true };
  const provider = vi.fn<typeof fetch>(async () => Response.json({ file: { name: "Fixture design", last_touched_at: "2026-11-07T00:00:00Z" }, credential: KEY }));
  const parent: OperatorParentAuthority = { redeem: vi.fn<OperatorParentAuthority["redeem"]>(async ({ envelope: value }) => ({ status: "admitted", effectiveDeadline: value.expiresAt })) };
  const capture = vi.fn(async (value: OperatorExecutionEnvelope) => {
    if (!native.tokenActive || !native.policyActive) throw Error("denied");
    return { tokenExpiresAt: input.expiresAt, request: prepareOperatorFigmaRequest(value,
      { id: "raw-1", revision: native.revision, service: "figma", connection_name: input.personalAlias, source: "local", value: "enc:worker:v1:fixture" },
      { id: "raw-1", revision: native.revision, service: "figma", connectionName: input.personalAlias, credential: { authType: "api_key", apiKey: KEY, values: { apiKey: KEY } } }, provider) };
  });
  const deps = { owner, store, deploymentEpoch: input.deploymentEpoch, versionId: input.versionId, manifestDigest: input.manifestDigest, parent, capture, now: () => now };
  const gateway = new OperatorGateway(deps);
  return { input, storage, store, owner, provider, parent, gateway, native, deps, capture, time: (value: number) => { now = value; }, execute: () => gateway.execute(input, TOKEN, "capability-fixture") };
}

describe("strict bounded operator envelope", () => {
  it("accepts canonical tuple and binds all executable fields", async () => { const input = await envelope(); expect(await parseOperatorEnvelope(parseOperatorJson(JSON.stringify(input)))).toEqual(input); await expect(parseOperatorEnvelope({ ...input, maxBytes: 2048 })).rejects.toThrow(); });
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"b":1,"b":2}}', '{"x":"\\ud800"}', '{"x":"\\udc00"}', '{"x":1e999}', '{"__proto__":{}}', '{"a":1,}', '[1,]', '{"x":01}']) ("rejects ambiguous/malformed JSON %s", text => { expect(() => parseOperatorJson(text)).toThrow(); });
  it("rejects deep or oversized JSON and accepts a valid surrogate pair", () => { expect(() => parseOperatorJson(`${"[".repeat(18)}1${"]".repeat(18)}`)).toThrow(); expect(() => parseOperatorJson(JSON.stringify("a".repeat(65536)))).toThrow(); expect(parseOperatorJson('"\\ud83d\\udc36"')).toBe("🐶"); });
  it.each(["ownerId", "personalAlias", "arguments", "inputSchemaHash", "argumentDigest", "grantVersions"])("rejects changed %s despite a recomputed outer digest", async field => {
    const input = await envelope(); const changed = { ...input, [field]: field === "arguments" ? { fileKey: "changed" } : field === "grantVersions" ? [input.grantVersions[0], input.grantVersions[0]] : field === "ownerId" ? "owner-2" : "x" } as OperatorExecutionEnvelope;
    changed.requestDigest = await operatorRequestDigest(changed); await expect(parseOperatorEnvelope(changed)).rejects.toThrow();
  });
});

describe("permanent one-shot operator gateway", () => {
  it("uses one fixed request and projects no provider credentials", async () => {
    const f = await fixture(), receipt = await f.execute(); expect(receipt.state).toBe("completed"); expect(receipt.result).toEqual({ name: "Fixture design", lastTouchedAt: "2026-11-07T00:00:00.000Z" }); expect(JSON.stringify(receipt)).not.toContain(KEY);
    const request = f.provider.mock.calls[0]?.[0] as Request; expect(request.url).toBe("https://api.figma.com/v1/files/file123/meta"); expect(request.redirect).toBe("manual"); expect(request.headers.get("X-Figma-Token")).toBe(KEY);
  });
  it("rejects credential reflection hidden in a permissively parsed timestamp", async () => {
    const f = await fixture(); f.provider.mockImplementation(async () => Response.json({ file: { name: "Fixture", last_touched_at: "2026-11-07 (figd_1234567890123456)" } }));
    expect((await f.execute()).state).toBe("unknown"); expect(JSON.stringify(f.store.lookup(f.input.invocationId, f.input.requestDigest))).not.toContain("figd_");
  });
  it("returns identical replay once, conflicts on changed inputs and consumes approval permanently", async () => {
    const f = await fixture(); const first = await f.execute(); expect(await f.execute()).toEqual(first); expect(f.provider).toHaveBeenCalledOnce();
    const changed = { ...f.input, arguments: { fileKey: "different" }, argumentDigest: await hash({ fileKey: "different" }) }; changed.requestDigest = await operatorRequestDigest(changed);
    await expect(f.gateway.execute(changed, TOKEN, "capability-fixture")).rejects.toThrow("operator_invocation_conflict");
    const retry = { ...f.input, invocationId: "second" }; retry.requestDigest = await operatorRequestDigest(retry);
    await expect(f.gateway.execute(retry, TOKEN, "capability-fixture")).rejects.toThrow("operator_approval_consumed"); expect(f.provider).toHaveBeenCalledOnce();
  });
  it("duplicates queued concurrently dispatch at most once", async () => { const f = await fixture(); const rows = await Promise.all([f.execute(), f.execute(), f.execute()]); expect(rows.every(row => row.state === "completed")).toBe(true); expect(f.provider).toHaveBeenCalledOnce(); });
  it("receipt pruning never prunes the invocation or consumed approval", async () => { const f = await fixture(); await f.execute(); f.store.prune(f.input.invocationId, f.input.requestDigest); f.time(Date.now() + 86400000); expect((await f.execute()).state).toBe("receipt_pruned"); expect(f.provider).toHaveBeenCalledOnce(); });
  it.each(["claimed", "admitted", "dispatch_committed"] as const)("restart converts %s to permanent unknown", async state => {
    const f = await fixture(); f.store.claim(f.input); if (state !== "claimed") f.store.transition({ invocationId: f.input.invocationId, requestDigest: f.input.requestDigest, state: "admitted", code: "in_progress" });
    if (state === "dispatch_committed") f.store.transition({ invocationId: f.input.invocationId, requestDigest: f.input.requestDigest, state, code: "in_progress" });
    new OperatorInvocationStore(f.storage).recover(); expect((await f.execute()).state).toBe("unknown"); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(["lost-ack", "unknown", "rejected"])("never sends after parent %s", async mode => {
    const f = await fixture(); f.parent.redeem = vi.fn<OperatorParentAuthority["redeem"]>(async () => { if (mode === "lost-ack") throw Error("ack lost"); return { status: mode === "unknown" ? "unknown" : "rejected" }; });
    expect((await f.execute()).state).toBe(mode === "rejected" ? "rejected_before_admission" : "unknown"); await f.execute(); expect(f.provider).not.toHaveBeenCalled(); expect(f.parent.redeem).toHaveBeenCalledOnce();
  });
  it.each(["timeout", "redirect", "oversize", "malformed", "http-error"])("permanently records uncertain %s without retry", async mode => {
    const f = await fixture(); f.input.maxDurationMs = 100; f.input.requestDigest = await operatorRequestDigest(f.input);
    f.provider.mockImplementation(async () => mode === "timeout" ? new Promise(() => {}) : mode === "redirect" ? new Response(null, { status: 302, headers: { location: "https://evil.test" } }) : mode === "oversize" ? Response.json({ big: "a".repeat(20000) }) : mode === "http-error" ? new Response("private error", { status: 401 }) : new Response('{"bad":', { headers: { "content-type": "application/json" } }));
    expect((await f.execute()).state).toBe("unknown"); expect((await f.execute()).state).toBe("unknown"); expect(f.provider).toHaveBeenCalledOnce();
  });
  it("checks expiry after the last awaited durable commit", async () => {
    const f = await fixture(); let syncs = 0; f.storage.syncHook = async () => { if (++syncs === 3) f.time(f.input.expiresAt); };
    expect((await f.execute()).state).toBe("unknown"); expect(f.provider).not.toHaveBeenCalled();
  });
  it("checks cancellation after the last awaited durable commit", async () => {
    const f = await fixture(), cancel = new AbortController(); let syncs = 0; f.storage.syncHook = async () => { if (++syncs === 3) cancel.abort(); };
    expect((await f.gateway.execute(f.input, TOKEN, "capability-fixture", cancel.signal)).state).toBe("unknown"); expect(f.provider).not.toHaveBeenCalled();
  });
  it("a failed dispatch-commit durability acknowledgement never sends", async () => {
    const f = await fixture(); let syncs = 0; f.storage.syncHook = async () => { if (++syncs === 3) throw Error("commit uncertain"); };
    expect((await f.execute()).state).toBe("unknown"); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(["revision", "tokenActive", "policyActive"] as const)("mutation admitted before execute wins: %s", async field => {
    const f = await fixture(); await f.owner.run(async () => { if (field === "revision") f.native[field] = "rotated"; else f.native[field] = false; });
    await expect(f.execute()).rejects.toThrow(); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(["revision", "tokenActive", "policyActive"] as const)("mutation waits while dispatch owns final parent await: %s", async field => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.parent.redeem = async () => { entered.resolve(); await release.promise; return { status: "admitted", effectiveDeadline: f.input.expiresAt }; };
    const call = f.execute(); await entered.promise; let mutated = false;
    const mutation = f.owner.run(async () => { mutated = true; if (field === "revision") f.native[field] = "rotated"; else f.native[field] = false; });
    await Promise.resolve(); expect(mutated).toBe(false); release.resolve(); expect((await call).state).toBe("completed"); await mutation; expect(mutated).toBe(true); expect(f.provider).toHaveBeenCalledOnce();
  });
  it("revocation barrier waits for an admitted dispatch and echoes its exact epoch and nonce", async () => {
    const f = await fixture(), entered = deferred(), release = deferred(); f.parent.redeem = async () => { entered.resolve(); await release.promise; return { status: "admitted", effectiveDeadline: f.input.expiresAt }; };
    const call = f.execute(); await entered.promise; let completed = false;
    const barrier = f.gateway.barrier({ deploymentEpoch: "epoch-1", revocationId: "revoke-1" }).then(value => { completed = true; return value; });
    await Promise.resolve(); expect(completed).toBe(false); release.resolve(); await call; expect(await barrier).toEqual({ deploymentEpoch: "epoch-1", revocationId: "revoke-1", status: "complete" }); expect(f.provider).toHaveBeenCalledOnce();
  });
  it("epoch retirement drains the old call, then prevents reactivation and old/new bypass", async () => {
    const f = await fixture(); await f.owner.run(async () => { f.store.retireEpoch("epoch-1"); });
    await expect(f.execute()).rejects.toThrow("operator_epoch_unavailable"); expect(() => f.store.initializeEpoch("epoch-1")).toThrow(); expect(() => f.store.initializeEpoch("epoch-2")).toThrow(); expect(f.provider).not.toHaveBeenCalled();
  });
});

function rawDatabase() {
  let writes = 0;
  const raw: CoordinatedD1 = { prepare: () => {
    const statement: CoordinatedD1Statement = { bind: () => statement, first: async () => null, all: async () => ({ results: [] }), run: async () => { writes++; return { success: true, meta: { changes: 1 } }; } }; return statement;
  }, batch: async statements => Promise.all(statements.map(async statement => { await statement.run(); return { results: [] }; })) };
  return { raw, writes: () => writes };
}
describe("native work owns its asynchronous mutation scope", () => {
  it("permanent cached DB facade uses current scope, but saved statements cannot escape it", async () => {
    const f = rawDatabase(), owner = new CoordinatedOwner(), db = owner.database(f.raw); let stale!: CoordinatedD1Statement;
    await owner.run(async () => { stale = db.prepare("write"); await stale.run(); });
    expect(() => db.prepare("write")).toThrow("operator_scope_closed");
    await owner.run(async () => { await expect(stale.run()).rejects.toThrow("operator_scope_mismatch"); });
    expect(f.writes()).toBe(1);
  });
  it("native appCache can reuse its original facade after owner reconstruction without retaining the old DB", async () => {
    const first = rawDatabase(), second = rawDatabase(), oldOwner = new CoordinatedOwner(), cached = oldOwner.database(first.raw);
    let stale!: CoordinatedD1Statement;
    await oldOwner.run(async () => { stale = cached.prepare("write"); await stale.run(); });
    const newOwner = new CoordinatedOwner(); newOwner.database(second.raw);
    await newOwner.run(async () => { await cached.prepare("write").run(); });
    await newOwner.run(async () => { await cached.batch([cached.prepare("write")]); });
    expect(first.writes()).toBe(1); expect(second.writes()).toBe(2);
    await newOwner.run(async () => { await expect(stale.run()).rejects.toThrow("operator_scope_mismatch"); });
  });
  it("normal appCache reuse uses the same facade safely across requests", async () => {
    const f = rawDatabase(), owner = new CoordinatedOwner(), db = owner.database(f.raw);
    await owner.run(async () => { await db.prepare("write").run(); }); await owner.run(async () => { await db.prepare("write").run(); }); expect(f.writes()).toBe(2);
  });
  it("nested waitUntil and unawaited SQL drain before the next mutation", async () => {
    const f = rawDatabase(), owner = new CoordinatedOwner(), db = owner.database(f.raw), release = deferred(), events: string[] = [];
    const first = owner.run(async ctx => { ctx.waitUntil(release.promise.then(async () => { events.push("background"); ctx.waitUntil(db.prepare("write").run()); })); });
    const next = owner.run(async () => { events.push("next"); }); await Promise.resolve(); expect(events).toEqual([]); release.resolve(); await Promise.all([first, next]); expect(events).toEqual(["background", "next"]); expect(f.writes()).toBe(1);
  });
  it("detached tasks retain closed context, even while another job owns the facade", async () => {
    const f = rawDatabase(), owner = new CoordinatedOwner(), db = owner.database(f.raw), release = deferred(), hold = deferred(); let detached!: Promise<void>;
    await owner.run(async () => { detached = release.promise.then(async () => { await db.prepare("write").run(); }); });
    const next = owner.run(async () => { release.resolve(); await expect(detached).rejects.toThrow("operator_scope_closed"); hold.resolve(); }); await next; expect(f.writes()).toBe(0);
  });
  it("does not time out and release an unresolved background mutation", async () => {
    const owner = new CoordinatedOwner(), release = deferred(); let next = false;
    const first = owner.run(async ctx => { ctx.waitUntil(release.promise); }); const second = owner.run(async () => { next = true; });
    await new Promise(done => setTimeout(done, 15)); expect(next).toBe(false); release.resolve(); await Promise.all([first, second]); expect(next).toBe(true);
  });
  it("refuses unsupported streaming and never exposes passthrough", async () => {
    const owner = new CoordinatedOwner(); await expect(owner.nativeFetch(async () => new Response("event", { headers: { "content-type": "text/event-stream" } }))).rejects.toThrow("operator_streaming_native_unsupported");
    await expect(owner.run(async ctx => ctx.passThroughOnException())).rejects.toThrow("operator_passthrough_forbidden");
  });
});
