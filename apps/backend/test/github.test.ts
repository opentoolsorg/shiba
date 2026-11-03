import { describe, expect, it, vi } from "vitest";
import { publishFilesAsPullRequest } from "../src/github.js";

const SECRET = "ghp_testtoken12345678";
const BASE_REVISION = "a".repeat(40);

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(calls: RecordedCall[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: BASE_REVISION } });
    }
    if (url.endsWith(`/git/commits/${BASE_REVISION}`)) {
      return json({ tree: { sha: "base-tree" } });
    }
    if (url.endsWith("/git/blobs")) {
      return json({ sha: `blob-${calls.length}` });
    }
    if (url.endsWith("/git/trees")) {
      return json({ sha: "new-tree" });
    }
    if (url.endsWith("/git/commits")) {
      return json({ sha: "new-commit" });
    }
    if (url.endsWith("/git/refs")) {
      return json({});
    }
    if (url.endsWith("/pulls")) {
      return json({ html_url: "https://github.com/owner/repo/pull/7", number: 7 });
    }
    return json({ message: "not found" }, 404);
  });
}

describe("publishFilesAsPullRequest", () => {
  const request = {
    repoUrl: "https://github.com/owner/repo", baseBranch: "main", baseRevision: BASE_REVISION,
    newBranch: "shiba/captured", title: "Captured change", body: "Details", message: "Captured change",
    files: [{ path: "source.ts", content: "approved body", encoding: "utf8" as const }], token: SECRET,
  };

  it("rejects an advanced base before uploading any stale file body", async () => {
    const calls: RecordedCall[] = [];
    const base = makeFetch(calls);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/git/ref/heads/main")) {
        calls.push({ url: String(input), init });
        return Response.json({ object: { sha: "b".repeat(40) } });
      }
      return base(input, init);
    });
    await expect(publishFilesAsPullRequest(request, { fetchImpl })).rejects.toThrow("base branch changed");
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  it("keeps the frozen tree and parent when the branch advances during publication", async () => {
    const calls: RecordedCall[] = [];
    const base = makeFetch(calls);
    let advanced = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/git/ref/heads/main") && advanced) return Response.json({ object: { sha: "b".repeat(40) } });
      if (url.endsWith("/git/blobs")) advanced = true;
      return base(input, init);
    });
    await publishFilesAsPullRequest(request, { fetchImpl });
    expect(advanced).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/git/ref/heads/main"))).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith(`/git/commits/${BASE_REVISION}`))).toBe(true);
    expect(calls.some((call) => call.url.endsWith(`/git/commits/${"b".repeat(40)}`))).toBe(false);
    const tree = calls.find((call) => call.url.endsWith("/git/trees"));
    const commit = calls.find((call) => call.url.endsWith("/git/commits"));
    expect(JSON.parse(String(tree?.init?.body)).base_tree).toBe("base-tree");
    expect(JSON.parse(String(commit?.init?.body)).parents).toEqual([BASE_REVISION]);
  });

  it.each(["", "main", "a".repeat(39), "A".repeat(40), "a".repeat(40) + "/main"])("rejects invalid captured revisions %j before any request", async (baseRevision) => {
    const calls: RecordedCall[] = [];
    await expect(publishFilesAsPullRequest({ ...request, baseRevision }, { fetchImpl: makeFetch(calls) })).rejects.toThrow("exact captured base revision");
    expect(calls).toHaveLength(0);
  });

  it("creates blobs, tree, commit, ref, and pull request in order", async () => {
    const calls: RecordedCall[] = [];
    const result = await publishFilesAsPullRequest(
      {
        repoUrl: "https://github.com/owner/repo",
        baseBranch: "main",
        baseRevision: BASE_REVISION,
        newBranch: "shiba/run-abc",
        title: "AI Coworker: fix",
        body: "details",
        files: [
          { path: "a.ts", content: "hello", encoding: "utf8" },
          { path: "img.png", content: "aGVsbG8=", encoding: "base64" },
        ],
        token: SECRET,
        message: "AI Coworker: fix",
      },
      { fetchImpl: makeFetch(calls) },
    );
    expect(result).toEqual({
      branch: "shiba/run-abc",
      commitSha: "new-commit",
      pullUrl: "https://github.com/owner/repo/pull/7",
      pullNumber: 7,
    });
    const paths = calls.map((call) => new URL(call.url).pathname);
    expect(paths).toEqual([
      "/repos/owner/repo/git/ref/heads/main",
      `/repos/owner/repo/git/commits/${BASE_REVISION}`,
      "/repos/owner/repo/git/blobs",
      "/repos/owner/repo/git/blobs",
      "/repos/owner/repo/git/trees",
      "/repos/owner/repo/git/commits",
      "/repos/owner/repo/git/refs",
      "/repos/owner/repo/pulls",
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
    }
    const treeCall = calls.find((call) => call.url.endsWith("/git/trees"));
    const treeBody = JSON.parse(String(treeCall?.init?.body)) as { base_tree: string; tree: unknown[] };
    expect(treeBody.base_tree).toBe("base-tree");
    expect(treeBody.tree).toHaveLength(2);
  });

  it("requires a token and files", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "a", content: "x", encoding: "utf8" }],
          token: "",
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/no changed files/i);
  });

  it("refuses unsafe file paths", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "../escape", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/unsafe file path/);
  });

  it("redacts secrets from API error messages", async () => {
    const failing = async () =>
      new Response(JSON.stringify({ message: `bad ${SECRET}` }), { status: 422 });
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "a", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: failing as typeof fetch },
      ),
    ).rejects.toThrow(/422/);
    try {
      await publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "a", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: failing as typeof fetch },
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("publishes deletions as null-content tree entries", async () => {
    const calls: RecordedCall[] = [];
    await publishFilesAsPullRequest(
      {
        repoUrl: "https://github.com/owner/repo",
        baseBranch: "main",
        baseRevision: BASE_REVISION,
        newBranch: "shiba/run-abc",
        title: "AI Coworker: delete",
        body: "details",
        files: [
          { path: "gone.ts", content: null, encoding: "utf8" },
          { path: "kept.ts", content: "x", encoding: "utf8" },
        ],
        token: SECRET,
        message: "AI Coworker: delete",
      },
      { fetchImpl: makeFetch(calls) },
    );
    // The deleted path needs no blob upload: only one blob call for kept.ts.
    expect(calls.filter((call) => call.url.endsWith("/git/blobs"))).toHaveLength(1);
    const treeCall = calls.find((call) => call.url.endsWith("/git/trees"));
    const body = JSON.parse(String(treeCall?.init?.body)) as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    expect(body.tree).toEqual([
      { path: "gone.ts", mode: "100644", type: "blob", sha: null },
      { path: "kept.ts", mode: "100644", type: "blob", sha: "blob-3" },
    ]);
  });

  it("removes the branch when the pull request cannot be created", async () => {
    const calls: RecordedCall[] = [];
    const base = makeFetch(calls);
    const failingPulls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/pulls")) {
        calls.push({ url, init });
        return new Response(JSON.stringify({ message: "pull creation refused" }), { status: 422 });
      }
      return base(input, init);
    });
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "shiba/run-abc",
          title: "t",
          body: "b",
          files: [{ path: "a.ts", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: failingPulls as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/shiba\/run-abc was removed/);
    const cleanup = calls.find(
      (call) => call.init?.method === "DELETE" && call.url.includes("/git/refs/heads/shiba"),
    );
    expect(cleanup).toBeDefined();
  });
});

describe("bounded blob uploads", () => {
  it("fails before any request when any file path is unsafe", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [
            { path: "ok.ts", content: "x", encoding: "utf8" },
            { path: "nested/../escape.ts", content: "x", encoding: "utf8" },
          ],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/unsafe file path/);
    // No ref lookup, blob upload, or write happens once validation fails.
    expect(calls).toHaveLength(0);
  });

  it("uploads blobs with bounded concurrency and preserves input order", async () => {
    const calls: RecordedCall[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const pending: Array<() => void> = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      if (url.endsWith("/git/blobs")) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        return new Promise<Response>((resolve) => {
          pending.push(() => {
            inflight -= 1;
            const body = JSON.parse(String(init?.body)) as { content: string };
            resolve(json({ sha: `sha-${body.content}` }));
          });
        });
      }
      if (url.endsWith("/git/ref/heads/main")) return Promise.resolve(json({ object: { sha: BASE_REVISION } }));
      if (url.endsWith(`/git/commits/${BASE_REVISION}`)) return Promise.resolve(json({ tree: { sha: "base-tree" } }));
      if (url.endsWith("/git/trees")) return Promise.resolve(json({ sha: "new-tree" }));
      if (url.endsWith("/git/commits")) return Promise.resolve(json({ sha: "new-commit" }));
      if (url.endsWith("/git/refs")) return Promise.resolve(json({}));
      if (url.endsWith("/pulls")) {
        return Promise.resolve(json({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }));
      }
      return Promise.resolve(json({ message: "not found" }, 404));
    });
    const files = Array.from({ length: 9 }, (_, i) => ({
      path: `f${i}.ts`,
      content: `content-${i}`,
      encoding: "utf8" as const,
    }));
    const publish = publishFilesAsPullRequest(
      {
        repoUrl: "https://github.com/owner/repo",
        baseBranch: "main",
        baseRevision: BASE_REVISION,
        newBranch: "b",
        title: "t",
        body: "b",
        files,
        token: SECRET,
        message: "m",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await new Promise((resolve) => setImmediate(resolve));
    // The pool starts at most four blob uploads before any resolves.
    expect(pending.length).toBe(4);
    // Release each deferred upload; the pool tops up until inputs run out.
    while (pending.length > 0) {
      pending.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await publish;
    expect(result.pullNumber).toBe(7);
    expect(maxInflight).toBeLessThanOrEqual(4);
    const treeCall = calls.find((call) => call.url.endsWith("/git/trees"));
    const body = JSON.parse(String(treeCall?.init?.body)) as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    expect(body.tree).toEqual(
      files.map((file) => ({ path: file.path, mode: "100644", type: "blob", sha: `sha-${file.content}` })),
    );
  });

  it("creates no tree or commit when a blob upload fails", async () => {
    const calls: RecordedCall[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      if (url.endsWith("/git/blobs")) {
        const body = JSON.parse(String(init?.body)) as { content: string };
        if (body.content === "doomed") {
          return Promise.resolve(json({ message: "blob rejected" }, 422));
        }
        return Promise.resolve(json({ sha: `sha-${body.content}` }));
      }
      if (url.endsWith("/git/ref/heads/main")) return Promise.resolve(json({ object: { sha: BASE_REVISION } }));
      if (url.endsWith(`/git/commits/${BASE_REVISION}`)) return Promise.resolve(json({ tree: { sha: "base-tree" } }));
      if (url.endsWith("/git/trees")) return Promise.resolve(json({ sha: "new-tree" }));
      if (url.endsWith("/git/commits")) return Promise.resolve(json({ sha: "new-commit" }));
      if (url.endsWith("/git/refs")) return Promise.resolve(json({}));
      if (url.endsWith("/pulls")) {
        return Promise.resolve(json({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }));
      }
      return Promise.resolve(json({ message: "not found" }, 404));
    });
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
        baseRevision: BASE_REVISION,
          newBranch: "b",
          title: "t",
          body: "b",
          files: [
            { path: "a.ts", content: "ok", encoding: "utf8" },
            { path: "b.ts", content: "doomed", encoding: "utf8" },
            { path: "c.ts", content: "ok2", encoding: "utf8" },
          ],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/422/);
    expect(calls.some((call) => call.url.endsWith("/git/trees"))).toBe(false);
    expect(
      calls.some((call) => call.url.endsWith("/git/commits") && call.init?.method === "POST"),
    ).toBe(false);
  });
});
