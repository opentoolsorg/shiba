import { describe, expect, it } from "vitest";
import {
  buildDenAgentName,
  driveObjectKey,
  legacyCaptainDriveObjectKey,
  parseDenAgentName,
  sanitizeDenSlug,
} from "@shiba/shared";

describe("den naming", () => {
  it("sanitizes slugs and round-trips agent names", () => {
    expect(sanitizeDenSlug("Fleet Alpha")).toBe("fleet-alpha");
    const name = buildDenAgentName("user@x", "fleet");
    expect(name).toBe("den:user@x:fleet");
    expect(parseDenAgentName(name)).toEqual({ userId: "user@x", slug: "fleet" });
  });

  it("accepts legacy captain: prefix", () => {
    expect(parseDenAgentName("captain:user@x:fleet")).toEqual({ userId: "user@x", slug: "fleet" });
  });

  it("uses den/ drive prefix with legacy captain/ alias path", () => {
    expect(driveObjectKey("den:u:main", "AGENTS.md")).toBe("den/den:u:main/drive/AGENTS.md");
    expect(legacyCaptainDriveObjectKey("captain:u:main", "AGENTS.md")).toBe(
      "captain/captain:u:main/drive/AGENTS.md",
    );
  });
});
