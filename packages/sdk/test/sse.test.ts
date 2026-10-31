import { describe, expect, it } from "vitest";
import { streamSse } from "../src/sse.js";

describe("streamSse", () => {
  it("parses incrementally without rescanning the whole buffer each chunk", async () => {
    const chunks = ["data: ", '{"ok":true}', "\n\n", "data: ", '{"n":2}', "\n\n"];
    let index = 0;
    const received: unknown[] = [];
    for await (const event of streamSse({
      url: "https://example.test/stream",
      headers: {},
      reconnect: false,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (index >= chunks.length) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode(chunks[index++]));
            },
          }),
          { status: 200 },
        ),
    })) {
      received.push(event);
    }
    expect(received).toEqual([{ ok: true }, { n: 2 }]);
  });
});
