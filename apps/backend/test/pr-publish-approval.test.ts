import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_TTL_MS, type PendingApproval } from "@shiba/shared";
import type { Env } from "../src/env.js";
import type { CodingTaskResult } from "../src/opencode-input.js";
import { executePrPublishApproval, stagePrPublishApproval, validatePrPublicationProposal } from "../src/pr-publish-approval.js";

const NOW = Date.parse("2026-11-03T19:00:00Z");
const TOKEN = "ghp_example_worker_only_secret_1234567890";
const expected = { ownerId: "owner@example.com", runId: "agent-tool:approved-run", sandboxId: "sandbox", repoUrl: "https://github.com/owner/repo", baseBranch: "main" };
const result: CodingTaskResult = { status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["source.ts"], diff: "", summary: "Task completed.", files: [{ path: "source.ts", content: "UNIQUE_STAGED_FILE_BYTES", encoding: "utf8" }] };

function setup() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = vi.fn(async (key: string, body: Uint8Array<ArrayBuffer>, _options?: R2PutOptions) => {
    if (objects.has(key)) return null;
    objects.set(key, new Uint8Array(body));
    return { key };
  });
  const get = vi.fn(async (key: string) => {
    const body = objects.get(key);
    return body ? { size: body.byteLength, arrayBuffer: async () => new Uint8Array(body).buffer } : null;
  });
  const env = { ATTACHMENTS: { put, get }, GITHUB_TOKEN: TOKEN } as unknown as Env;
  const fetchImpl = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = String(resource);
    const response = (value: unknown) => Response.json(value);
    if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: "base" } });
    if (url.endsWith("/git/commits/base")) return response({ tree: { sha: "base-tree" } });
    if (url.endsWith("/git/blobs")) return response({ sha: "blob" });
    if (url.endsWith("/git/trees")) return response({ sha: "tree" });
    if (url.endsWith("/git/commits")) return response({ sha: "commit" });
    if (url.endsWith("/git/refs")) return response({});
    if (url.endsWith("/pulls")) return response({ html_url: "https://github.com/owner/repo/pull/42", number: 42 });
    throw new Error(`Unexpected fake request ${init?.method ?? "GET"}.`);
  });
  const stage = (overrides: Partial<Parameters<typeof stagePrPublishApproval>[1]> = {}) => stagePrPublishApproval(env, { ...expected, task: "Fix source.", result, now: NOW, ...overrides });
  return { env, objects, put, get, fetchImpl, stage };
}

function approved(proposal: Awaited<ReturnType<typeof stagePrPublishApproval>>, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return { ...proposal, status: "approved", decidedBy: "owner@example.com", decidedAt: NOW, ...overrides };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe("distinct approval for publishing captured repository files", () => {
  it("stages immutable bytes and exposes only the action digest and ownership metadata", async () => {
    const s = setup();
    const proposal = await s.stage();
    expect(proposal.kind).toBe("pr_publish");
    expect(proposal.approvalId).toBe(`pr-publish:${expected.runId}`);
    expect(proposal.payload).toMatchObject(expected);
    expect(proposal.payload.fileCount).toBe(1);
    expect(JSON.stringify(proposal)).not.toContain("UNIQUE_STAGED_FILE_BYTES");
    expect(JSON.stringify(proposal)).not.toContain(TOKEN);
    const bytes = s.objects.get(proposal.payload.artifactKey);
    expect(bytes).toBeDefined();
    expect(createHash("sha256").update(bytes ?? new Uint8Array()).digest("hex")).toBe(proposal.payload.sha256);
    expect(s.put.mock.calls[0]?.[2]?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(await s.stage()).toEqual(proposal);
    expect(s.objects.size).toBe(1);
  });

  it("publishes only the approved immutable files after the separate human decision", async () => {
    const s = setup();
    const proposal = await s.stage();
    const published = await executePrPublishApproval(s.env, approved(proposal), expected, { fetchImpl: s.fetchImpl });
    expect(published.pullUrl).toBe("https://github.com/owner/repo/pull/42");
    const blob = s.fetchImpl.mock.calls.find(([resource]) => String(resource).endsWith("/git/blobs"));
    expect(JSON.parse(String(blob?.[1]?.body))).toMatchObject({ content: "UNIQUE_STAGED_FILE_BYTES", encoding: "utf-8" });
    expect(s.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(5);
    for (const [, init] of s.fetchImpl.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    { status: "pending" as const }, { status: "rejected" as const }, { kind: "run" as const },
    { decidedBy: "" }, { decidedBy: "automation:job" }, { decidedBy: "agent:coder" }, { decidedBy: "mcp:token" },
    { decidedBy: "system:worker" }, { decidedAt: undefined }, { decidedAt: NOW + 1 },
    { execution: { status: "failed" as const, executedAt: NOW, error: "Previous outcome is unknown." } },
    { execution: { status: "executed" as const, executedAt: NOW } },
  ])("blocks non-human, unresolved, replayed or malformed approval %j before any read or write", async (change) => {
    const s = setup(); const proposal = await s.stage();
    await expect(executePrPublishApproval(s.env, approved(proposal, change), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("human approval");
    expect(s.get).not.toHaveBeenCalled(); expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an unexpired action approval independently of the earlier sandbox execution decision", async () => {
    const s = setup(); const proposal = await s.stage();
    vi.setSystemTime(NOW + APPROVAL_TTL_MS + 1);
    await expect(executePrPublishApproval(s.env, approved(proposal), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("human approval");
    expect(s.get).not.toHaveBeenCalled(); expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unrelated human and accepts a currently allowlisted Slack approver", async () => {
    const s = setup(); const proposal = await s.stage();
    await expect(executePrPublishApproval(s.env, approved(proposal, { decidedBy: "intruder@example.com" }), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("authorized human");
    expect(s.get).not.toHaveBeenCalled(); expect(s.fetchImpl).not.toHaveBeenCalled();
    s.env.SLACK_APPROVERS = "U_APPROVER";
    const published = await executePrPublishApproval(s.env, approved(proposal, { decidedBy: "U_APPROVER" }), expected, { fetchImpl: s.fetchImpl });
    expect(published.pullNumber).toBe(42);
  });

  it.each([
    { ownerId: "other" }, { runId: "other" }, { sandboxId: "other" }, { repoUrl: "https://github.com/owner/other" }, { baseBranch: "other" },
  ])("rejects proposal ownership or target substitution %j", async (change) => {
    const s = setup(); const proposal = await s.stage();
    expect(() => validatePrPublicationProposal(proposal, { ...expected, ...change })).toThrow("completed run");
    await expect(executePrPublishApproval(s.env, approved(proposal), { ...expected, ...change }, { fetchImpl: s.fetchImpl })).rejects.toThrow("completed run");
    expect(s.get).not.toHaveBeenCalled(); expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects replaced, truncated and forged frozen artifacts before resolving credentials or touching GitHub", async () => {
    const s = setup(); const proposal = await s.stage();
    const key = proposal.payload.artifactKey;
    const original = s.objects.get(key) ?? new Uint8Array();
    const changed = new Uint8Array(original); changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1;
    s.objects.set(key, changed);
    await expect(executePrPublishApproval(s.env, approved(proposal), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("digest");
    s.objects.set(key, original.subarray(0, original.length - 1));
    await expect(executePrPublishApproval(s.env, approved(proposal), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("missing or has changed");
    s.objects.set(key, original);
    await expect(executePrPublishApproval(s.env, approved({ ...proposal, payload: { ...proposal.payload, sha256: "a".repeat(64) } }), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("digest");
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("checks the staged owner even if a pointer and its digest are changed together", async () => {
    const s = setup(); const proposal = await s.stage();
    const other = await s.stage({ ownerId: "other" });
    const forged = { ...proposal, payload: { ...proposal.payload, artifactKey: other.payload.artifactKey, sha256: other.payload.sha256, bytes: other.payload.bytes } };
    await expect(executePrPublishApproval(s.env, approved(forged), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow("identity");
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["../secret.ts", "/etc/passwd", "a/../../b", ".git/config", "a\\b", "a\u0000b", "a//b"])("refuses unsafe staged file %j before storage", async (path) => {
    const s = setup();
    await expect(s.stage({ result: { ...result, files: [{ path, content: "data", encoding: "utf8" }] } })).rejects.toThrow();
    expect(s.put).not.toHaveBeenCalled();
  });

  it("refuses incomplete, excessive, credential-bearing and failed run proposals", async () => {
    const s = setup();
    for (const invalid of [
      { ...result, status: "error" as const }, { ...result, exitCode: 1 }, { ...result, files: [] },
      { ...result, files: [{ path: "a.bin", content: "YR==", encoding: "base64" as const }] },
      { ...result, files: [{ path: "a.ts", content: TOKEN, encoding: "utf8" as const }] },
      { ...result, files: Array.from({ length: 51 }, (_, index) => ({ path: `${index}.ts`, content: "x", encoding: "utf8" as const })) },
      { ...result, files: Array.from({ length: 5 }, (_, index) => ({ path: `${index}.ts`, content: "x".repeat(500_000), encoding: "utf8" as const })) },
    ]) await expect(s.stage({ result: invalid })).rejects.toThrow();
    expect(s.put).not.toHaveBeenCalled();
  });

  it.each(["socket", "status"])("does not repeat an uncertain PR creation or delete its branch after %s failure", async (failure) => {
    const s = setup(); const proposal = await s.stage();
    const baseFetch = s.fetchImpl.getMockImplementation();
    s.fetchImpl.mockImplementation(async (resource, init) => {
      if (String(resource).endsWith("/pulls")) {
        if (failure === "socket") throw new TypeError("Socket closed after request delivery.");
        return new Response("Unknown write outcome.", { status: 503 });
      }
      if (!baseFetch) throw new Error("Fake transport unavailable.");
      return baseFetch(resource, init);
    });
    await expect(executePrPublishApproval(s.env, approved(proposal), expected, { fetchImpl: s.fetchImpl })).rejects.toThrow();
    expect(s.fetchImpl.mock.calls.filter(([resource]) => String(resource).endsWith("/pulls"))).toHaveLength(1);
    expect(s.fetchImpl.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});
