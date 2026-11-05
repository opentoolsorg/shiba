import { afterEach, expect, it, vi } from "vitest";
import { RunOutputArchiveClient } from "./run-output-archive-client";
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
