// The setup page is a plain script in a sandboxed page: no module system, no
// shared import. These tests run it against a minimal DOM stub to prove the
// rejection copy comes from fixed strings, including when an older main sends a
// code without a sentence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "..", "src", "setup.js"), "utf8");

type Page = { readonly error: string | null; submit(): Promise<void> };

function runSetup(result: unknown): Page {
  const state: { error: string | null } = { error: null };
  const error = {
    get textContent() {
      return state.error ?? "";
    },
    set textContent(value: string) {
      state.error = value;
    },
  };
  const input = {
    value: "",
    disabled: false,
    required: false,
    setAttribute: (_name: string, _value: string) => {},
    focus: () => {},
    addEventListener: () => {},
  };
  const choice = { checked: false, removeAttribute: () => {}, setAttribute: () => {}, addEventListener: () => {} };
  const hosted = { ...choice, checked: true };
  const selfHosted = { ...choice };
  const fields = { hidden: true };
  const hostedUrl = { textContent: "" };
  const button = { disabled: false };
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | null = null;
  const form = {
    addEventListener: (_name: string, handler: never) => {
      submit = handler;
    },
    querySelector: () => button,
  };
  const elements: Record<string, unknown> = {
    error,
    form,
    hosted,
    "self-hosted": selfHosted,
    "self-hosted-fields": fields,
    url: input,
    "hosted-url": hostedUrl,
  };
  const context = {
    URLSearchParams,
    URL,
    location: { search: "?hosted=https://app.tryshiba.dev" },
    window: { shibaSetup: { setUrl: async () => result } },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: () => button,
    },
  };
  vm.runInNewContext(SOURCE, context);
  expect(submit).not.toBeNull();
  return {
    get error() {
      return state.error;
    },
    submit: () => submit!({ preventDefault() {} }),
  };
}

describe("setup page rejection copy", () => {
  it.each([
    ["url_invalid", "That is not a Shiba address. Use https:// (http://localhost only in dev)."],
    ["url_wrong_frame", "Only the setup page can change the address."],
    ["pairing_busy", "A connection change is already running."],
  ])("maps %s to fixed copy when an older main sends only a code", async (code, copy) => {
    const page = runSetup({ ok: false, code });
    await page.submit();
    expect(page.error).toBe(copy);
  });

  it("uses the shell's sentence when one arrives", async () => {
    const page = runSetup({ ok: false, code: "url_invalid", error: "Fixed shell sentence." });
    await page.submit();
    expect(page.error).toBe("Fixed shell sentence.");
  });

  it("never echoes the typed address on an unknown code", async () => {
    const page = runSetup({ ok: false, code: "something_new" });
    await page.submit();
    expect(page.error).toBe("Could not save that address. Check the URL and try again.");
  });
});
