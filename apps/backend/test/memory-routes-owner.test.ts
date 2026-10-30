import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleMemory } from "../src/memory-routes.js";

describe("owner-scoped memory API routing", () => {
  function fixture() {
    const names: string[] = [];
    const forwarded: Array<{ name: string; url: string; method: string; body: string }> = [];
    const namespace = {
      idFromName(name: string) {
        names.push(name);
        return name;
      },
      get(name: string) {
        return {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            forwarded.push({
              name,
              url: request.url,
              method: request.method,
              body: request.method === "GET" ? "" : await request.text(),
            });
            return Response.json({ sources: [] });
          },
        };
      },
    };
    const env = { Memory: namespace, REQUIRE_ACCESS: "1" } as unknown as Env;
    return { env, names, forwarded };
  }

  it("derives owner partitions from the authenticated identity and ignores owner query parameters", async () => {
    const { env, names, forwarded } = fixture();
    await handleMemory(
      new Request("https://app.test/api/memory/sources?owner=bob", {
        headers: { "CF-Access-Authenticated-User-Email": "alice@example.test" },
      }),
      env,
    );
    await handleMemory(
      new Request("https://app.test/api/memory/sources", {
        headers: { "CF-Access-Authenticated-User-Email": "bob@example.test" },
      }),
      env,
    );
    expect(names[0]).toMatch(/^owner-memory:[a-f0-9]{64}$/);
    expect(names[0]).not.toBe(names[1]);
    expect(forwarded[0]?.url).toBe("https://internal/internal/memory/sources");
    expect(forwarded.map((call) => call.body)).toEqual(["", ""]);
  });

  it("forwards source edits and text to the authenticated owner's private partition", async () => {
    const { env, names, forwarded } = fixture();
    const request = new Request("https://app.test/api/memory/sources/memsrc_1", {
      method: "PATCH",
      headers: {
        "CF-Access-Authenticated-User-Email": "alice@example.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "my own note", enabled: false }),
    });
    const response = await handleMemory(request, env);
    expect(response?.status).toBe(200);
    expect(names).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      url: "https://internal/internal/memory/sources/memsrc_1",
      method: "PATCH",
    });
    expect(JSON.parse(forwarded[0]?.body ?? "")).toEqual({
      content: "my own note",
      enabled: false,
    });
  });

  it("scopes legacy fact and session compatibility to the authenticated agent identity", async () => {
    const { env, names, forwarded } = fixture();
    const headers = { "CF-Access-Authenticated-User-Email": "alice@example.test" };
    await handleMemory(
      new Request("https://app.test/api/memory/facts?agent=bob@example.test&q=secret&limit=4", { headers }),
      env,
    );
    await handleMemory(
      new Request("https://app.test/api/memory/sessions?agent=bob@example.test", { headers }),
      env,
    );
    await handleMemory(
      new Request("https://app.test/api/memory/facts/fact-from-bob?agent=bob@example.test", {
        method: "DELETE",
        headers,
      }),
      env,
    );

    expect(forwarded[0]?.url).toBe(
      "https://internal/internal/memory/facts/search?agent=alice%40example.test&limit=4&q=secret",
    );
    expect(forwarded[1]?.url).toBe(
      "https://internal/internal/memory/sessions?agent=alice%40example.test",
    );
    expect(names[2]).toBe("alice@example.test");
    expect(forwarded[2]?.url).toBe(
      "https://internal/internal/memory/facts/fact-from-bob",
    );
    expect(forwarded[2]?.method).toBe("DELETE");
  });

  it("fails closed for a non-loopback request without an authenticated owner", async () => {
    const { env, names } = fixture();
    const response = await handleMemory(new Request("https://app.test/api/memory/sources"), env);
    expect(response?.status).toBe(401);
    expect(names).toEqual([]);
  });

  it("never interprets the reserved global registry as a caller-owned partition", async () => {
    const { env, names, forwarded } = fixture();
    const response = await handleMemory(
      new Request("https://app.test/api/memory/facts", {
        headers: { "CF-Access-Authenticated-User-Email": " global " },
      }),
      env,
    );
    expect(response?.status).toBe(404);
    expect(names).toEqual([]);
    expect(forwarded).toEqual([]);
  });
});
