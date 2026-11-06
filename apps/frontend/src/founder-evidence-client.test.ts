import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { founderEvidenceReportHash, FOUNDER_EVIDENCE_MAX_BYTES } from "@shiba/shared";
import { FounderEvidenceClient } from "./founder-evidence-client";
import { EVIDENCE_WORKSPACE, EVIDENCE_LIBRARY, EVIDENCE_BASE, evidenceInput, evidenceOptions, evidencePreview, evidenceRecord, evidenceSummary } from "./founder-evidence-fixtures";
afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const client = () => new FounderEvidenceClient(EVIDENCE_WORKSPACE, EVIDENCE_LIBRARY);
const respond = (body: unknown, status = 200) => { const fetcher = vi.fn(async () => Response.json(body, { status })); vi.stubGlobal("fetch", fetcher); return fetcher; };
async function failure(value: Promise<unknown>) { const error = await value.then(() => null, (cause: unknown) => cause); expect(error).toBeInstanceOf(Error); return (error as Error).message; }

describe("private founder evidence contracts", () => {
  it.each([false, true])("matches crypto.subtle for exact UTF8 array bytes including the size boundary (%s)", async (boundary) => {
    const value = { manifestDigest: "f".repeat(64), expiresAt: 1_800_000_000_000, markdown: boundary ? "é".repeat(65_536) : "é\n🐕\\quoted\"\u2028", json: boundary ? "🐕".repeat(32_768) : JSON.stringify({ line: "\n", symbol: "𝌆" }) };
    if (boundary) expect(new TextEncoder().encode(value.markdown).length + new TextEncoder().encode(value.json).length).toBe(FOUNDER_EVIDENCE_MAX_BYTES);
    const bytes = new TextEncoder().encode(JSON.stringify(["shiba.founder-evidence.v1", value.manifestDigest, value.expiresAt, value.markdown, value.json]));
    const actual = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)), (part) => part.toString(16).padStart(2, "0")).join("");
    expect(founderEvidenceReportHash(value)).toBe(actual);
  });
  it("uses native fetch and scoped metadata without implicit selection or POST", async () => {
    const fetcher = vi.fn(async function (this: unknown) { expect(this).toBe(globalThis); return Response.json(evidenceOptions()); }); vi.stubGlobal("fetch", fetcher);
    await client().options(signal());
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`${EVIDENCE_BASE}/options`); expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(new Headers(init.headers).get("X-Shiba-Workspace")).toBe(EVIDENCE_WORKSPACE); expect(init.body).toBeUndefined();
  });
  it("rejects actor/workspace substitution and wrong employee receipts", async () => {
    const instance = client(); respond(evidenceOptions()); await instance.options(signal());
    respond({ ...evidenceOptions(true), actorId: "other@example.test" });
    expect(await failure(instance.options(signal(), { id: "employee-one", version: 2 }))).toMatch(/another native account or workspace/);
    respond({ ...evidenceOptions(true), receipts: evidenceOptions(true).receipts.map((item) => ({ ...item, employeeVersion: 9 })) });
    expect(await failure(client().options(signal(), { id: "employee-one", version: 2 }))).toMatch(/selected employee version/);
  });
  it("checks preview full content hash and exact selected refs, not only HTTP success", async () => {
    const input = evidenceInput(), preview = evidencePreview(input); respond(preview);
    expect((await client().preview(input, signal())).reportHash).toBe(preview.reportHash);
    respond({ ...preview, markdown: `${preview.markdown}\nchanged` });
    expect(await failure(client().preview(input, signal()))).toMatch(/content, source lease or hash/);
    respond({ ...preview, receipts: preview.receipts.map((item) => ({ ...item, resultDigest: "0".repeat(64) })) });
    expect(await failure(client().preview(input, signal()))).toMatch(/selected source receipts/);
  });
  it("binds Create to reviewed hash and a stable request UUID and rejects swapped bytes", async () => {
    const input = evidenceInput(), preview = evidencePreview(input), record = evidenceRecord(preview), fetcher = respond(record);
    await client().create(input, preview, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", signal());
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(path).toBe(EVIDENCE_BASE);
    expect(JSON.parse(String(init.body))).toEqual({ ...input, expectedReportHash: preview.reportHash, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    respond({ ...record, json: '{"substitution":true}' });
    expect(await failure(client().create(input, preview, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", signal()))).toMatch(/content, source lease or hash/);
  });
  it("verifies exact authenticated download bytes and never creates a Blob or URL", async () => {
    const record = evidenceRecord(), instance = client(); respond(record); await instance.read(record.id, signal(), record.reportHash);
    const fetcher = vi.fn(async () => new Response(record.markdown)); vi.stubGlobal("fetch", fetcher);
    expect(await instance.download(record, "markdown", signal())).toBe(record.markdown);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(`${EVIDENCE_BASE}/${record.id}/download?format=markdown`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("tampered")));
    expect(await failure(instance.download(record, "markdown", signal()))).toMatch(/downloaded bytes/);
  });
  it("requires exact metadata-only revocation and does not retry failures", async () => {
    const record = evidenceRecord(), summary = { ...evidenceSummary(record), state: "revoked", canRead: false, canRevoke: false };
    respond({ ...evidenceOptions(), report: summary }); expect((await client().revoke(record, signal())).state).toBe("revoked");
    const fetcher = respond({ error: "not reflected" }, 409);
    expect(await failure(client().revoke(record, signal()))).toMatch(/changed/); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects expired content and caller cancellation before any request", async () => {
    const preview = evidencePreview(), expired = { ...preview, expiresAt: Date.now() - 1 }; expired.reportHash = founderEvidenceReportHash(expired);
    const fetcher = respond(expired);
    expect(await failure(client().create(evidenceInput(), expired, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", signal()))).toMatch(/lease or hash/); expect(fetcher).not.toHaveBeenCalled();
    const aborted = new AbortController(); aborted.abort(); await expect(client().options(aborted.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
