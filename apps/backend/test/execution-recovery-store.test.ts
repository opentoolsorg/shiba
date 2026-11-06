import { describe, expect, it } from "vitest";
import { ExecutionRecoveryStore } from "../src/execution-recovery-store.js";
import type { PreparedRuntimeExecution } from "../src/runtime-recovery.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const input = { dispatchEnvelopeHash: "a".repeat(64), dispatchApprovalId: "approval", dispatchExpiresAt: 30_000 } as CodingTaskInput;
const capsule: PreparedRuntimeExecution = {
  version: 1, phase: "harness", provider: "cloudflare", sandboxId: "sandbox", harness: "opencode",
  workdir: "/workspace/sandbox", approvalId: "approval", inputHash: "b".repeat(64), envelopeHash: "a".repeat(64),
  commandIdentity: "c".repeat(64), jobId: "d".repeat(64), issuedAt: 1_000, preparedAt: 2_000,
  deadline: 20_000, recoveryDeadline: 30_000, baseRevision: "e".repeat(40), baselineCommit: "f".repeat(40), setupCommit: null,
};
function storage() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { rows.set(key, structuredClone(value)); },
  };
}

describe("private execution recovery state", () => {
  it("retains the original harness capsule across a Worker lifetime", async () => {
    const disk = storage();
    const original = new ExecutionRecoveryStore(disk);
    await original.begin(input);
    await original.prepared(input, capsule);
    const recovered = new ExecutionRecoveryStore(disk);
    expect(await recovered.read(input)).toMatchObject({ phase: "harness", capsule });
    await expect(recovered.begin(input)).rejects.toThrow("already recorded");
    await expect(recovered.prepared(input, capsule)).rejects.toThrow("already consumed");
    expect(JSON.stringify([...disk.rows.values()])).not.toContain("command:");
  });

  it("commits settlement before accepting a final result and never reenters it", async () => {
    const disk = storage();
    const store = new ExecutionRecoveryStore(disk);
    await store.begin(input);
    await store.prepared(input, capsule);
    await expect(store.complete(input, "premature")).rejects.toThrow("this phase");
    await store.settling(input);
    expect((await new ExecutionRecoveryStore(disk).read(input))?.phase).toBe("settling");
    await expect(store.settling(input)).rejects.toThrow("already consumed");
    await store.complete(input, "safe structured final result");
    await store.failed(input);
    expect(await store.read(input)).toMatchObject({ phase: "complete", finalText: "safe structured final result" });
  });

  it.each(["dispatchEnvelopeHash", "dispatchApprovalId", "dispatchExpiresAt"] as const)("rejects changed %s", async (field) => {
    const store = new ExecutionRecoveryStore(storage());
    await store.begin(input);
    const changed = { ...input, [field]: field === "dispatchExpiresAt" ? 40_000 : "forged" };
    await expect(store.read(changed)).rejects.toThrow("identity changed");
  });

  it("rejects corrupt persisted capsule identity and missing terminal text", async () => {
    const disk = storage();
    const store = new ExecutionRecoveryStore(disk);
    await store.begin(input);
    await expect(store.prepared(input, { ...capsule, envelopeHash: "0".repeat(64) })).rejects.toThrow("changed");
    const key = [...disk.rows.keys()][0]!;
    const record = disk.rows.get(key) as object;
    disk.rows.set(key, { ...record, phase: "complete" });
    await expect(store.read(input)).rejects.toThrow("incomplete");
    disk.rows.set(key, { ...record, phase: "harness", capsule: { ...capsule, envelopeHash: "0".repeat(64) } });
    await expect(store.read(input)).rejects.toThrow("capsule identity changed");
  });

  it("does not create a capsule when durable preparation fails", async () => {
    const disk = storage();
    const store = new ExecutionRecoveryStore(disk);
    await store.begin(input);
    const failing = new ExecutionRecoveryStore({ ...disk, async put() { throw new Error("storage unavailable"); } });
    await expect(failing.prepared(input, capsule)).rejects.toThrow("storage unavailable");
    expect((await new ExecutionRecoveryStore(disk).read(input))?.phase).toBe("preparing");
  });

  it("replays a large valid result exactly without exceeding a storage value limit", async () => {
    const disk = storage();
    const store = new ExecutionRecoveryStore(disk);
    await store.begin(input);
    await store.settling(input);
    const text = JSON.stringify({ changedFiles: Array.from({ length: 50 }, (_, index) => `${index}/${"界".repeat(1_000)}`), diff: "+".repeat(40_000) });
    expect(text.length).toBeGreaterThan(80_000);
    await store.complete(input, text);
    expect((await new ExecutionRecoveryStore(disk).read(input))?.finalText).toBe(text);
    for (const value of disk.rows.values()) expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(128 * 1024);
    const chunkKey = [...disk.rows.keys()].find((key) => key.endsWith(":result:0"))!;
    disk.rows.set(chunkKey, "altered");
    await expect(store.read(input)).rejects.toThrow("cache changed");
  });

  it("does not publish a terminal receipt after a partial result cache write", async () => {
    const disk = storage();
    const store = new ExecutionRecoveryStore(disk);
    await store.begin(input);
    await store.settling(input);
    const interrupted = new ExecutionRecoveryStore({ ...disk, async put(key, value) {
      if (key.endsWith(":result:1")) throw new Error("evicted during cache write");
      await disk.put(key, value);
    } });
    await expect(interrupted.complete(input, "x".repeat(70_000))).rejects.toThrow("evicted");
    expect((await new ExecutionRecoveryStore(disk).read(input))?.phase).toBe("settling");
  });
});
