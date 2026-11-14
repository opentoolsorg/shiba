import { describe, expect, it, vi } from "vitest";
import { handleVoiceRoutes, MAX_VOICE_BYTES, WHISPER_MODEL } from "../src/voice-routes.js";

describe("voice transcribe route", () => {
  it("transcribes audio with mocked Workers AI", async () => {
    const run = vi.fn(async () => ({ text: " hello world " }));
    const env = { AI: { run } } as never;
    const request = new Request("https://app.example/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    const auth = vi.spyOn(await import("../src/request-auth.js"), "isAuthorizedRequest").mockResolvedValue(true);
    const response = await handleVoiceRoutes(request, env);
    auth.mockRestore();
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { ok: boolean; text: string };
    expect(body).toEqual({ ok: true, text: "hello world" });
    expect(run).toHaveBeenCalledWith(WHISPER_MODEL, expect.objectContaining({ audio: expect.any(String) }));
  });

  it("rejects oversized payloads", () => {
    expect(MAX_VOICE_BYTES).toBe(25 * 1024 * 1024);
  });
});