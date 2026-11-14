import { describe, expect, it, vi } from "vitest";
import { generateImage } from "../src/tools/image-gen.js";

describe("generate_image tool", () => {
  it("stores a png in output storage", async () => {
    const put = vi.fn(async () => true);
    const env = {
      AI: { run: vi.fn(async () => ({ image: btoa("png-bytes") })) },
      ARTIFACTS: { put },
    } as never;
    const result = await generateImage(env, { prompt: "shiba mascot", aspect: "square", runId: "chat-1" });
    expect(result.ok).toBe(true);
    expect(put).toHaveBeenCalledOnce();
    const call = put.mock.calls[0] as unknown as [string, unknown, { customMetadata?: { kind?: string } }];
    expect(call[2].customMetadata?.kind).toBe("output");
  });
});