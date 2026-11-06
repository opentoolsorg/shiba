import { afterEach, expect, it, vi } from "vitest";
import { RunOutputArchiveClient } from "./run-output-archive-client";
import { stableHash, stableJson, type JsonValue } from "@shiba/shared";
import { archiveFixture, OUTPUT_ARCHIVE_ID, OUTPUT_RUN, OUTPUT_SESSION } from "./run-output-archive-fixtures";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("makes only explicit authenticated readonly requests and validates the exact retained hash chain", async () => {
  const f = archiveFixture(), requests: RequestInit[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(init!); return Response.json(String(input).includes("?after=") ? f.page : f.directory); });
  const client = new RunOutputArchiveClient(OUTPUT_RUN, OUTPUT_SESSION, transport);
  expect(transport).not.toHaveBeenCalled(); await client.directory(new AbortController().signal);
  expect((await client.page(OUTPUT_ARCHIVE_ID, new AbortController().signal)).events[0]?.event.data).toContain("retained prefix");
  expect(requests.every((init) => init.method === "GET" && init.credentials === "same-origin" && init.cache === "no-store" && init.redirect === "error" && init.body === undefined)).toBe(true);
});
it.each(["bytes", "account", "lease", "job", "sequence", "false-completion"])("rejects a substituted %s response without a retry", async (which) => {
  const f = archiveFixture();
  if (which === "bytes") f.page.events[0]!.event.data += "changed";
  if (which === "account") f.page.ownerAccountId = "replacement-native";
  if (which === "lease") f.page.expiresAt++;
  if (which === "job") f.page.jobId = "d".repeat(64);
  if (which === "sequence") f.page.events[0]!.ordinal = 2;
  if (which === "false-completion") f.page.state = "complete";
  const transport = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("?after=") ? f.page : f.directory));
  const client = new RunOutputArchiveClient(OUTPUT_RUN, OUTPUT_SESSION, transport); await client.directory(new AbortController().signal);
  await expect(client.page(OUTPUT_ARCHIVE_ID, new AbortController().signal)).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(2);
});
it("keeps native fetch receiver and rejects cancellation before reading or sending", async () => {
  const f = archiveFixture(), fetcher = vi.fn(async function (this: unknown) { expect(this).toBe(globalThis); return Response.json(f.directory); }); vi.stubGlobal("fetch", fetcher);
  const client = new RunOutputArchiveClient(OUTPUT_RUN, OUTPUT_SESSION); await client.directory(new AbortController().signal);
  const controller = new AbortController(); controller.abort(); await expect(client.page(OUTPUT_ARCHIVE_ID, controller.signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("exports a verified multi-page snapshot and checks current authority again before returning it", async () => {
  const f = archiveFixture(), first = structuredClone(f.page), second = structuredClone(f.page);
  const event = { ...second.events[0]!, ordinal: 2, eventId: "22222222-2222-4222-8222-222222222222", roomSequence: 8,
    event: { ...second.events[0]!.event, data: "second page\n" } };
  event.chainDigest = stableHash([first.chainDigest, [OUTPUT_ARCHIVE_ID, event.ordinal, event.eventId, event.roomSequence, event.sourceSequence, stableJson(event.event as unknown as JsonValue), event.createdAt]]);
  Object.assign(first, { eventCount: 2, hasMore: true, chainDigest: event.chainDigest });
  Object.assign(second, { eventCount: 2, after: 1, nextCursor: 2, previousChainDigest: first.events[0]!.chainDigest, chainDigest: event.chainDigest, events: [event] });
  let denyFinal = false, changeFrontier = false, pageReads = 0;
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes("?after=")) return Response.json(f.directory);
    pageReads++;
    if (denyFinal && pageReads === 3) return new Response(null, { status: 404 });
    return Response.json(String(input).endsWith("after=0") ? first : changeFrontier ? { ...second, lastObservedSource: 2 } : second);
  });
  const client = new RunOutputArchiveClient(OUTPUT_RUN, OUTPUT_SESSION, transport), signal = new AbortController().signal;
  await client.directory(signal);
  const snapshot = await client.exportSnapshot(OUTPUT_ARCHIVE_ID, signal);
  expect(snapshot.events.map((item) => item.event.data)).toEqual([first.events[0]!.event.data, "second page\n"]);
  expect(snapshot).toMatchObject({ incompleteTail: true, tailUpperBound: null, chainDigest: event.chainDigest, eventCount: 2 });
  expect(pageReads).toBe(3);
  pageReads = 0; denyFinal = true;
  await expect(client.exportSnapshot(OUTPUT_ARCHIVE_ID, signal)).rejects.toThrow();
  pageReads = 0; denyFinal = false; changeFrontier = true;
  await expect(client.exportSnapshot(OUTPUT_ARCHIVE_ID, signal)).rejects.toThrow();
});
