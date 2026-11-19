// The persistent log has two doors: structured `event()` records with an
// allowlisted key set, and `line()` for raw text. Only the first may have a
// producer, so this scan fails the build if any main-process module starts
// writing raw text — an exception message, a response body, a repository name.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOG_FIELDS, createLogger, formatLogEvent } from "../src/logs.js";

const SRC = join(__dirname, "..", "src");
const sources = readdirSync(SRC)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

describe("no raw text producer reaches the log sink", () => {
  it("never calls the raw line writer outside the logger itself", () => {
    for (const { name, text } of sources) {
      if (name === "logs.ts") continue;
      const calls = text.match(/\.line\(/g) ?? [];
      expect(calls, `${name} writes raw log text`).toHaveLength(0);
    }
  });

  it("keeps the allowlisted key set free of a free-form field", () => {
    expect([...LOG_FIELDS]).toEqual(["event", "state", "code", "action", "url", "bytes"]);
  });

  it("drops any raw content a caller tries to smuggle into a record", () => {
    // `detail` is not a field any more, so the key and its text vanish.
    const line = formatLogEvent({
      event: "approval",
      state: "failed",
      detail: "Exception: connect ECONNREFUSED acme/widgets",
    } as never);
    expect(JSON.parse(line)).toEqual({ event: "approval", state: "failed" });
  });

  it("retains only bounded codes when a caller passes an error-shaped string", () => {
    const line = formatLogEvent({ event: "disconnect", state: "failed", code: 401 });
    expect(JSON.parse(line)).toEqual({ event: "disconnect", state: "failed", code: 401 });
  });
});
