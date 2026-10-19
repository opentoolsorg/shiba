import { describe, expect, it } from "vitest";
import { buildCaptainAgentName, driveObjectKey, parseCaptainAgentName, sanitizeCaptainSlug } from "@shiba/shared";

describe("captain naming", () => {
  it("sanitizes slugs and builds agent names", () => {
    expect(sanitizeCaptainSlug("Fleet Alpha")).toBe("fleet-alpha");
    const name = buildCaptainAgentName("user@x", "fleet");
    expect(name).toBe("captain:user@x:fleet");
    expect(parseCaptainAgentName(name)).toEqual({ userId: "user@x", slug: "fleet" });
  });

  it("maps drive paths to R2 keys", () => {
    expect(driveObjectKey("captain:u:main", "AGENTS.md")).toBe("captain/captain:u:main/drive/AGENTS.md");
  });
});
