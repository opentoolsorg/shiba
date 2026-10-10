import { expect, it } from "vitest";
import { buildTrayMenu } from "../src/tray";

const t = { notifications: true, startAtLogin: false };
const ids = (m: ReturnType<typeof buildTrayMenu>) => m.flatMap((i) => (i.type === "item" ? [i.id] : []));

it("unpaired offers Connect, not Disconnect", () => {
  const m = buildTrayMenu({ state: "unpaired" }, t);
  expect(ids(m)).toContain("connect");
  expect(ids(m)).not.toContain("disconnect");
});

it("idle offers Disconnect and shows agy as listed only", () => {
  const m = buildTrayMenu({ state: "idle", harnesses: ["claude", "agy"] }, t);
  expect(ids(m)).toContain("disconnect");
  expect(JSON.stringify(m)).toContain("agy (listed only)");
});

it("reflects toggles and ends with Quit", () => {
  const m = buildTrayMenu({ state: "idle" }, t);
  expect(m.find((i) => i.type === "item" && i.id === "start-at-login")).toMatchObject({ checked: false });
  expect(m.at(-1)).toMatchObject({ id: "quit" });
});

it.each(["conflict", "crashed"] as const)("%s offers Retry", (state) => {
  expect(ids(buildTrayMenu({ state }, t))).toContain("retry");
});

it.each(["idle", "revoked", "unpaired"] as const)("%s has no Retry", (state) => {
  expect(ids(buildTrayMenu({ state }, t))).not.toContain("retry");
});

it("conflict offers neither Connect nor Disconnect — the lock holder owns the config (REVIEW3 F5)", () => {
  const m = buildTrayMenu({ state: "conflict" }, t);
  expect(ids(m)).not.toContain("disconnect");
  expect(m.find((i) => i.type === "item" && i.id === "connect")).toMatchObject({ enabled: false });
});
