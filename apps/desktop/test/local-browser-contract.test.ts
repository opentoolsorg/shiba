import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BROWSER_CHANNELS } from "../src/local-browser-contract.js";

const source = (name: string) => readFileSync(path.join(import.meta.dirname, "../src", name), "utf8");

describe("local browser bridge contract", () => {
  it("keeps local controls out of the remote dashboard preload", () => {
    const dashboardPreload = source("preload.ts");
    const localPreload = source("local-browser-preload.ts");
    expect(dashboardPreload).not.toContain("shibaLocalBrowser");
    expect(localPreload).toContain('location.protocol === "file:"');
    expect(localPreload).toContain("/local-browser\\.html$/");
    expect(localPreload).toContain('contextBridge.exposeInMainWorld("shibaLocalBrowser"');
    for (const channel of Object.values(LOCAL_BROWSER_CHANNELS)) expect(localPreload).toContain(channel);
  });
});
