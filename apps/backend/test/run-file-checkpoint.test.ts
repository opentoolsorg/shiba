import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunFileCheckpointStore, type FileCheckpointPolicy, type FileCheckpointStorage } from "../src/run-file-checkpoint.js";

const policy: FileCheckpointPolicy = {
  version: 1, consent: "approved-files", ownerAccountId: "account-1", sessionId: "session-1", runId: "run-1",
  approvalId: "approval-1", envelopeHash: "a".repeat(64), sourceEpoch: "epoch-1", leaseId: "lease-1",
  createdAt: 1_000, expiresAt: 20_000, paths: ["out/report.txt"],
};
const files = [{ path: "out/report.txt", content: "approved report\n" }];
function fixture() {
  let now = 2_000;
  let allowed = true;
  let failPut = false;
  let failDelete = false;
  let afterPut = () => {};
  let afterGet = () => {};
  let beforePut: () => Promise<void> = async () => {};
  let onAuthorize: (action: string) => Promise<void> = async () => {};
  const records = new Map<string, unknown>();
  const objects = new Map<string, string>();
  const tx = {
    async get<T>(key: string) { return structuredClone(records.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
  };
  let pending = Promise.resolve();
  const storage: FileCheckpointStorage = { ...tx, transaction<T>(callback: Parameters<FileCheckpointStorage["transaction"]>[0]) {
    const operation = pending.then(() => callback(tx));
    pending = operation.then(() => {}, () => {});
    return operation as Promise<T>;
  } };
  const bucket = {
    async put(key: string, text: string) {
      await beforePut();
      if (failPut) { objects.set(key, text.slice(0, 25)); throw new Error("interrupted upload"); }
      objects.set(key, text); afterPut();
    },
    async get(key: string) {
      const text = objects.get(key);
      afterGet();
      return text === undefined ? null : { size: new TextEncoder().encode(text).byteLength, async text() { return text; } };
    },
    async delete(key: string) { if (failDelete) throw new Error("delete unavailable"); objects.delete(key); },
  };
  const store = new RunFileCheckpointStore(storage, bucket, async (_policy, action) => { await onAuthorize(action); if (!allowed) throw new Error("authority revoked"); }, () => now);
  return { store, records, objects, storage, bucket,
    clock: (value: number) => { now = value; }, deny: () => { allowed = false; },
    failPut: (value: boolean) => { failPut = value; }, failDelete: () => { failDelete = true; },
    beforePut: (callback: () => Promise<void>) => { beforePut = callback; },
    onAuthorize: (callback: (action: string) => Promise<void>) => { onAuthorize = callback; },
    onPut: (callback: () => void) => { afterPut = callback; }, onGet: (callback: () => void) => { afterGet = callback; } };
}

describe("private opt-in approved file checkpoint", () => {
  it("round-trips actual temporary file contents through fixture object storage, not a process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shiba-file-checkpoint-"));
    try {
      const source = join(directory, "source.txt");
      const target = join(directory, "restored.txt");
      await writeFile(source, "bounded report ✓\n");
      const f = fixture();
      const checkpoint = await f.store.capture(policy, [{ path: "out/report.txt", content: await readFile(source, "utf8") }]);
      await rm(source);
      const restored = await f.store.read(policy);
      await writeFile(target, restored.files[0]!.content, { flag: "wx" });
      expect(await readFile(target, "utf8")).toBe("bounded report ✓\n");
      expect(restored).toMatchObject({ kind: "approved-files", checkpointHash: checkpoint.checkpointHash,
        processRestored: false, outputAcknowledgment: null, unknownTail: true });
      expect([...f.records.values()].map((value) => JSON.stringify(value)).join()).not.toContain("bounded report");
      expect([...f.objects.keys()][0]).not.toContain(policy.ownerAccountId);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not access storage without explicit consent", async () => {
    const f = fixture();
    await expect(f.store.capture({ ...policy, consent: undefined } as unknown as FileCheckpointPolicy, files)).rejects.toThrow();
    expect(f.records.size).toBe(0); expect(f.objects.size).toBe(0);
  });

  it.each(["ownerAccountId", "sessionId", "runId", "approvalId", "envelopeHash", "sourceEpoch", "leaseId"] as const)("refuses mismatched %s", async (field) => {
    const f = fixture(); await f.store.capture(policy, files);
    const changed = { ...policy, [field]: field === "envelopeHash" ? "b".repeat(64) : "other" };
    await expect(f.store.read(changed)).rejects.toThrow();
    await expect(f.store.capture(changed, files)).rejects.toThrow();
  });

  it("fails closed on missing receipt or object", async () => {
    const f = fixture(); await expect(f.store.read(policy)).rejects.toThrow();
    await f.store.capture(policy, files); f.objects.clear();
    await expect(f.store.read(policy)).rejects.toThrow("unavailable");
  });

  it.each(["body", "manifest", "policy", "invalid-json"])("rejects corrupt %s before releasing any files", async (kind) => {
    const f = fixture(); await f.store.capture(policy, files);
    const [key, text] = [...f.objects.entries()][0]!;
    const snapshot = JSON.parse(text);
    if (kind === "body") snapshot.files[0].content = "tampered";
    if (kind === "manifest") snapshot.files[0].sha256 = "b".repeat(64);
    if (kind === "policy") snapshot.policyHash = "b".repeat(64);
    f.objects.set(key, kind === "invalid-json" ? "{" : JSON.stringify(snapshot));
    await expect(f.store.read(policy)).rejects.toThrow();
  });

  it("holds partial uploads pending and permits only explicit identical upload retry", async () => {
    const f = fixture(); f.failPut(true);
    await expect(f.store.capture(policy, files)).rejects.toThrow("interrupted");
    await expect(f.store.read(policy)).rejects.toThrow("incomplete");
    await expect(f.store.capture(policy, [{ ...files[0]!, content: "changed" }])).rejects.toThrow("claimed");
    f.failPut(false); await f.store.capture(policy, files);
    expect((await f.store.read(policy)).files[0]!.content).toBe(files[0]!.content);
  });

  it("deduplicates identical checkpoints and refuses changed file retries", async () => {
    const f = fixture(); const first = await f.store.capture(policy, files);
    expect(await f.store.capture(policy, files)).toEqual(first); expect(f.objects.size).toBe(1);
    await expect(f.store.capture(policy, [{ ...files[0]!, content: "different" }])).rejects.toThrow("claimed");
  });

  it("serializes concurrent changed checkpoint claims", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.store.capture(policy, files), f.store.capture(policy, [{ ...files[0]!, content: "different" }])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.objects.size).toBe(1);
  });

  it("rechecks authority after upload and never commits after revocation", async () => {
    const f = fixture(); f.onPut(f.deny);
    await expect(f.store.capture(policy, files)).rejects.toThrow("revoked");
    expect([...f.records.values()][0]).toMatchObject({ state: "pending" });
    await expect(f.store.read(policy)).rejects.toThrow("revoked");
  });

  it("rechecks authority after object read", async () => {
    const f = fixture(); await f.store.capture(policy, files); f.onGet(f.deny);
    await expect(f.store.read(policy)).rejects.toThrow("revoked");
  });

  it("rejects local revocation during final external authorization", async () => {
    const f = fixture(); await f.store.capture(policy, files);
    let resume!: () => void;
    let arrived!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    let reads = 0;
    f.onAuthorize(async (action) => {
      if (action === "read" && ++reads === 2) { arrived(); await blocked; }
    });
    const result = f.store.read(policy);
    const rejected = expect(result).rejects.toThrow("revoked");
    await waiting; await f.store.revoke(policy); resume(); await rejected;
  });

  it("reconciles an upload that completes after revocation deleted its object", async () => {
    const f = fixture();
    let resume!: () => void;
    let arrived!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    f.beforePut(async () => { arrived(); await blocked; });
    const result = f.store.capture(policy, files);
    const rejected = expect(result).rejects.toThrow("claim changed");
    await waiting; await f.store.revoke(policy); resume(); await rejected;
    expect(f.objects.size).toBe(0);
    expect([...f.records.values()][0]).toMatchObject({ state: "revoked" });
    await expect(f.store.read(policy)).rejects.toThrow("revoked");
  });

  it("reconciles uncertain late storage effects without reopening a retired receipt", async () => {
    const f = fixture(); await f.store.capture(policy, files);
    const [key, text] = [...f.objects.entries()][0]!;
    await f.store.revoke(policy);
    f.objects.set(key, text);
    await f.store.cleanupRetired();
    expect(f.objects.size).toBe(0);
    await expect(f.store.read(policy)).rejects.toThrow("revoked");
  });

  it("checks lease expiry after asynchronous object reads", async () => {
    const f = fixture(); await f.store.capture(policy, files); f.onGet(() => f.clock(policy.expiresAt));
    await expect(f.store.read(policy)).rejects.toThrow("lease");
  });

  it("revokes durably before uncertain object deletion and never reopens", async () => {
    const f = fixture(); await f.store.capture(policy, files); f.failDelete();
    await expect(f.store.revoke(policy)).rejects.toThrow("delete unavailable");
    await expect(f.store.read(policy)).rejects.toThrow("revoked");
    await expect(f.store.capture(policy, files)).rejects.toThrow("revoked");
  });

  it("purges expired bytes without renewing the receipt or requiring an active session", async () => {
    const f = fixture(); await f.store.capture(policy, files);
    await expect(f.store.purgeExpired()).rejects.toThrow("not expired");
    f.clock(policy.expiresAt); f.deny(); await f.store.purgeExpired();
    expect(f.objects.size).toBe(0); expect([...f.records.values()][0]).toMatchObject({ state: "revoked" });
  });

  it.each(["../report.txt", "/out/report.txt", "out/link/../report.txt", ".env", "out/auth.json", "out/credentials.json"])("rejects unsafe path %s", async (path) => {
    const f = fixture();
    await expect(f.store.capture({ ...policy, paths: [path] }, [{ path, content: "text" }])).rejects.toThrow();
    expect(f.objects.size).toBe(0);
  });

  it.each(["password=not-for-storage", '{"api_key":"not-for-storage"}', "-----BEGIN PRIVATE KEY-----\nx", "control\u0000byte", "bad\ud800unicode"])("rejects credential-like or invalid content", async (content) => {
    const f = fixture(); await expect(f.store.capture(policy, [{ ...files[0]!, content }])).rejects.toThrow("unsafe");
    expect(f.objects.size).toBe(0);
  });

  it("rejects per-file UTF-8 bytes, total bytes, missing and duplicate files", async () => {
    const f = fixture();
    await expect(f.store.capture(policy, [{ ...files[0]!, content: "✓".repeat(6_000) }])).rejects.toThrow("bound");
    const paths = Array.from({ length: 5 }, (_, i) => `out/report${i}.txt`);
    await expect(f.store.capture({ ...policy, paths }, paths.map((path) => ({ path, content: "x".repeat(16_384) })))).rejects.toThrow("bound");
    await expect(f.store.capture(policy, [])).rejects.toThrow("every approved");
    await expect(f.store.capture({ ...policy, paths: ["out/report.txt", "out/other.txt"] }, [files[0]!, files[0]!])).rejects.toThrow("path");
  });
});
