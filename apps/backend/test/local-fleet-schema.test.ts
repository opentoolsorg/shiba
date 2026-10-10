import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeOrNull, HeartbeatRequestSchema } from "../src/local-fleet-schema.js";

describe("decodeOrNull", () => {
  it("returns validated input or null for a schema mismatch", () => {
    const heartbeat = {
      machineId: "machine", hostname: "host", platform: "darwin",
      daemonVersion: "1", harnesses: ["codex"],
    };
    expect(decodeOrNull(HeartbeatRequestSchema, heartbeat)).toEqual(heartbeat);
    expect(decodeOrNull(HeartbeatRequestSchema, { ...heartbeat, machineId: "" })).toBeNull();
  });

  it("does not disguise a decoder defect as invalid client input", () => {
    const broken = Schema.declare((_: unknown): _ is string => {
      throw new Error("decoder bug");
    });
    expect(() => decodeOrNull(broken, "input")).toThrow("decoder bug");
  });
});
