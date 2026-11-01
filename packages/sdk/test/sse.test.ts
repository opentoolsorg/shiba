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

async function collectFrame(frame: string): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of streamSse({
    url: "https://example.test/stream", headers: {}, reconnect: false,
    fetch: async () => new Response(frame),
  })) events.push(event);
  return events;
}

describe("SSE framing limits and line endings", () => {
  it.each(["\r\n", "\r"])("normalizes multiline data using %j", async (eol) => {
    expect(await collectFrame(`id: first${eol}data: a${eol}data: b${eol}${eol}`)).toEqual(["a\nb"]);
  });

  it("accepts multiple individually bounded frames in one large chunk", async () => {
    const payload = "x".repeat(300_000);
    expect(await collectFrame(`data: ${payload}\n\ndata: ${payload}\n\n`)).toEqual([payload, payload]);
  });

  it.each(["", "\n\n"])("rejects an oversized frame with delimiter %j", async (delimiter) => {
    await expect(collectFrame(`data: ${"x".repeat(512_001)}${delimiter}`)).rejects.toMatchObject({ status: 413 });
  });

  it.each(["\r\n", "\r"])("reconnects with a clean event id using %j", async (eol) => {
    const controller = new AbortController();
    const headers: Headers[] = [];
    for await (const _event of streamSse({
      url: "https://example.test/stream", headers: {}, signal: controller.signal,
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        if (headers.length === 2) controller.abort();
        return new Response(`id: first${eol}data: a${eol}data: b${eol}${eol}`);
      },
    })) { /* read through the reconnect */ }
    expect(headers[1]?.get("last-event-id")).toBe("first");
  });
});
