import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/knowledge/knowledge-search.js";

describe("knowledge search RRF", () => {
  it("boosts items appearing in both vector and keyword lists", () => {
    const fused = reciprocalRankFusion([
      [{ chunkId: "a" }, { chunkId: "b" }, { chunkId: "c" }],
      [{ chunkId: "b" }, { chunkId: "d" }],
    ]);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("a")!);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("d")!);
  });
});