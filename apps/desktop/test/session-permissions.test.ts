import { describe, expect, it } from "vitest";
import { shouldAllowSessionPermission } from "../src/session-permissions.js";

const ORIGIN = "https://shiba.example.com";
const TRUSTED = `${ORIGIN}/app/`;

describe("shouldAllowSessionPermission", () => {
  it("allows microphone (audio-only media) from the configured origin", () => {
    expect(
      shouldAllowSessionPermission("media", TRUSTED, ORIGIN, { mediaTypes: ["audio"] }),
    ).toBe(true);
    expect(
      shouldAllowSessionPermission("media", TRUSTED, ORIGIN, { mediaType: "audio" }),
    ).toBe(true);
  });

  it("denies video and audio+video media", () => {
    expect(
      shouldAllowSessionPermission("media", TRUSTED, ORIGIN, { mediaTypes: ["video"] }),
    ).toBe(false);
    expect(
      shouldAllowSessionPermission("media", TRUSTED, ORIGIN, { mediaTypes: ["audio", "video"] }),
    ).toBe(false);
  });

  it("denies media from an untrusted origin", () => {
    expect(
      shouldAllowSessionPermission("media", "https://evil.example/app/", ORIGIN, {
        mediaTypes: ["audio"],
      }),
    ).toBe(false);
  });

  it("keeps clipboard-sanitized-write and other permissions unchanged", () => {
    expect(shouldAllowSessionPermission("clipboard-sanitized-write", TRUSTED, ORIGIN)).toBe(true);
    expect(
      shouldAllowSessionPermission("clipboard-sanitized-write", "https://evil.example/", ORIGIN),
    ).toBe(false);
    expect(shouldAllowSessionPermission("notifications", TRUSTED, ORIGIN)).toBe(false);
    expect(shouldAllowSessionPermission("media", TRUSTED, ORIGIN, { mediaTypes: [] })).toBe(false);
  });
});