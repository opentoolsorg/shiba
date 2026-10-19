import { describe, expect, it } from "vitest";
import { Shiba, ShibaApiError } from "../src/index.js";
import { redactSecrets } from "../src/errors.js";
import { startMockShiba } from "./mock-server.js";

describe("@shiba/sdk client", () => {
  it("lists threads against the mock server", async () => {
    const mock = await startMockShiba();
    const shiba = new Shiba({ baseUrl: mock.baseUrl, apiKey: "shk_test_key" });
    const threads = await shiba.threads.list();
    expect(threads[0]?.threadId).toBe("t1");
    await mock.close();
  });

  it("auto-fills requestId on create", async () => {
    const mock = await startMockShiba();
    const shiba = new Shiba({ baseUrl: mock.baseUrl, apiKey: "shk_test_key" });
    const created = await shiba.threads.create({ repoUrl: "https://github.com/a/r", task: "hi" });
    expect(created.approvalId).toBe("a1");
    await mock.close();
  });

  it("streams SSE events", async () => {
    const mock = await startMockShiba();
    const shiba = new Shiba({ baseUrl: mock.baseUrl, apiKey: "shk_test_key" });
    const events = [];
    for await (const event of shiba.threads.stream("t1", { reconnect: false })) {
      events.push(event);
    }
    expect((events[0] as { type?: string })?.type).toBe("run.completed");
    await mock.close();
  });

  it("redacts secrets in errors", async () => {
    const mock = await startMockShiba();
    const shiba = new Shiba({ baseUrl: mock.baseUrl, apiKey: "shk_secret_value_12345678" });
    await expect(shiba.threads.list()).rejects.toBeInstanceOf(ShibaApiError);
    expect(redactSecrets("token shk_secret_value_12345678")).not.toContain("shk_secret");
    await mock.close();
  });
});
