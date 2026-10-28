import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Env } from "../src/env.js";
import {
  deliverableStorageKey,
  persistRunDeliverables,
  verifyExpectedDeliverables,
} from "../src/run-deliverables.js";

const file = (path: string, content: string | null, encoding: "utf8" | "base64" = "utf8") => ({ path, content, encoding });
function storage() {
  const objects = new Map<string, { body: unknown; options: unknown }>();
  const put = vi.fn(async (key: string, body: unknown, options: unknown) => {
    objects.set(key, { body, options });
    return { key };
  });
  const env = { ATTACHMENTS: { put } as unknown as R2Bucket } satisfies Pick<Env, "ATTACHMENTS">;
  return { env, put, objects };
}

describe("requested workspace deliverables", () => {
  it("is opt-in and ignores unrequested captures", async () => {
    const files = [file(".env", "SECRET=not-an-artifact")];
    expect(await verifyExpectedDeliverables(undefined, files)).toEqual([]);
    expect(await verifyExpectedDeliverables([], files)).toEqual([]);
    expect(await persistRunDeliverables({} as Pick<Env, "ATTACHMENTS">, "run", [])).toEqual([]);
  });

  it("preserves requested order and exact UTF-8 bytes with deterministic hashes", async () => {
    const report = "# Résumé\nResearch draft\n";
    const artifacts = await verifyExpectedDeliverables(["research/report.md", "plan.json"], [
      file("plan.json", '{"draft":true}\n'),
      file("private.txt", "not requested"),
      file("research/report.md", report),
    ]);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(["research/report.md", "plan.json"]);
    expect(artifacts[0]).toEqual({
      path: "research/report.md", content: report, bytes: Buffer.byteLength(report),
      mediaType: "text/markdown; charset=utf-8", sha256: createHash("sha256").update(report).digest("hex"),
    });
    expect(artifacts[1]?.mediaType).toBe("application/json; charset=utf-8");
  });

  it("preserves a UTF-8 markdown BOM in content, byte length, hash, and storage", async () => {
    const content = "\ufeff# Research draft\n";
    const artifacts = await verifyExpectedDeliverables(["report.md"], [file("report.md", content)]);
    expect(artifacts[0]).toMatchObject({
      content,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    const s = storage();
    await persistRunDeliverables(s.env, "bom-run", artifacts);
    expect([...s.objects.values()][0]?.body).toBe(content);
  });

  it.each(["../report.md", "/report.md", ".private/report.md", "a/../report.md", "a\\report.md", "report.html", "a\u0000.md"])("rejects unsafe requested path %j", async (path) => {
    await expect(verifyExpectedDeliverables([path], [file(path, "draft")])).rejects.toThrow("Invalid expected deliverable paths");
  });

  it("rejects ambiguous requested paths and excessive file counts", async () => {
    await expect(verifyExpectedDeliverables(["draft.md", "DRAFT.md"], [])).rejects.toThrow("Invalid expected");
    await expect(verifyExpectedDeliverables(Array.from({ length: 9 }, (_, i) => `${i}.txt`), [])).rejects.toThrow("Invalid expected");
    await expect(verifyExpectedDeliverables(["draft.md"], [file("draft.md", "a"), file("draft.md", "b")])).rejects.toThrow("exactly one");
  });

  it.each([
    ["missing", []],
    ["deleted or uncaptured", [file("draft.md", null)]],
    ["base64", [file("draft.md", "ZHJhZnQ=", "base64")]],
    ["blank", [file("draft.md", " \n\t")]],
    ["binary", [file("draft.md", "draft\u0000data")]],
    ["invalid unicode", [file("draft.md", "draft\ud800")]],
  ] as const)("fails a %s output instead of claiming completion", async (_label, files) => {
    await expect(verifyExpectedDeliverables(["draft.md"], files)).rejects.toThrow();
  });

  it("rejects malformed JSON without modifying valid JSON text", async () => {
    await expect(verifyExpectedDeliverables(["plan.json"], [file("plan.json", '{"draft":')])).rejects.toThrow("not valid JSON");
    const content = "{\n  \"draft\": true\n}\n";
    expect((await verifyExpectedDeliverables(["plan.json"], [file("plan.json", content)]))[0]?.content).toBe(content);
  });

  it("enforces byte limits rather than character limits and never truncates", async () => {
    const full = "é".repeat(8192);
    expect((await verifyExpectedDeliverables(["report.txt"], [file("report.txt", full)]))[0]).toMatchObject({ bytes: 16384, content: full });
    await expect(verifyExpectedDeliverables(["report.txt"], [file("report.txt", full + "é")])).rejects.toThrow("exceeds 16384 bytes");
    const paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
    await expect(verifyExpectedDeliverables(paths, paths.map((path) => file(path, "x".repeat(16384))))).rejects.toThrow("65536 bytes in total");
    expect(await verifyExpectedDeliverables(paths.slice(0, 4), paths.map((path) => file(path, "x".repeat(16384))))).toHaveLength(4);
  });

  it("stores only approved captures with attachment MIME metadata and returns no bodies", async () => {
    const artifacts = await verifyExpectedDeliverables(["report.csv", "notes.txt"], [
      file("report.csv", "channel,visits\nemail,12\n"), file("notes.txt", "Draft notes\n"), file(".env", "never persist"),
    ]);
    const s = storage();
    const metadata = await persistRunDeliverables(s.env, "run-1", artifacts);
    expect(metadata).toEqual(artifacts.map(({ content: _content, ...item }) => item));
    expect(s.put).toHaveBeenCalledTimes(2);
    expect(s.objects.get(deliverableStorageKey("run-1", artifacts[0]!.sha256, 0))).toEqual({
      body: "channel,visits\nemail,12\n", options: { httpMetadata: { contentType: "text/csv; charset=utf-8" } },
    });
    expect([...s.objects.values()].every(({ body }) => body !== "never persist")).toBe(true);
  });

  it("does not overwrite different content when sandbox identities collide and preserves ordinals", async () => {
    const first = await verifyExpectedDeliverables(["draft.md"], [file("draft.md", "Owner one's draft")]);
    const second = await verifyExpectedDeliverables(["draft.md"], [file("draft.md", "Owner two's draft")]);
    const s = storage();
    await persistRunDeliverables(s.env, "same-run", first);
    await persistRunDeliverables(s.env, "same-run", second);
    expect(s.objects.size).toBe(2);
    expect(s.objects.get(deliverableStorageKey("same-run", first[0]!.sha256, 0))?.body).toBe("Owner one's draft");
    expect(deliverableStorageKey("same-run", first[0]!.sha256, 0)).not.toBe(deliverableStorageKey("same-run", first[0]!.sha256, 1));
  });

  it("rejects forged metadata before persisting any artifact", async () => {
    const [artifact] = await verifyExpectedDeliverables(["draft.md"], [file("draft.md", "Draft")]);
    const s = storage();
    await expect(persistRunDeliverables(s.env, "run", [{ ...artifact!, bytes: 0 }])).rejects.toThrow("metadata does not match");
    expect(s.put).not.toHaveBeenCalled();
  });

  it("fails when durable storage is unavailable or rejects the write", async () => {
    const artifacts = await verifyExpectedDeliverables(["draft.md"], [file("draft.md", "Draft")]);
    await expect(persistRunDeliverables({} as Pick<Env, "ATTACHMENTS">, "run", artifacts)).rejects.toThrow("not configured");
    const s = storage();
    s.put.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(persistRunDeliverables(s.env, "run", artifacts)).rejects.toThrow("storage unavailable");
    s.put.mockResolvedValueOnce(null as never);
    await expect(persistRunDeliverables(s.env, "run", artifacts)).rejects.toThrow("could not be stored");
  });

  it("rejects invalid storage identities and escapes the sandbox segment", () => {
    const hash = "a".repeat(64);
    expect(deliverableStorageKey("some/run", hash, 0)).toBe(`run-deliverables/some%2Frun/0-${hash}`);
    expect(() => deliverableStorageKey("run", "not-a-hash", 0)).toThrow();
    expect(() => deliverableStorageKey("run", hash, -1)).toThrow();
    expect(() => deliverableStorageKey("run", hash, 8)).toThrow();
  });
});
