import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT =
  '<script defer data-website-id="6z2l59176o1m005i" src="https://minilytics.princepal.dev/js/script.js"></script>';

describe("Minilytics marketing tag", () => {
  test("MarketingPage and docs BaseLayout load the Shiba site from princepal.dev", () => {
    const marketing = readFileSync(new URL("../src/layouts/MarketingPage.astro", import.meta.url), "utf8");
    const docs = readFileSync(new URL("../src/layouts/BaseLayout.astro", import.meta.url), "utf8");
    assert.match(marketing, /<script defer data-website-id="6z2l59176o1m005i" src="https:\/\/minilytics\.princepal\.dev\/js\/script\.js"><\/script>/);
    assert.match(docs, /<script defer data-website-id="6z2l59176o1m005i" src="https:\/\/minilytics\.princepal\.dev\/js\/script\.js"><\/script>/);
    assert.ok(marketing.includes(SCRIPT));
    assert.ok(docs.includes(SCRIPT));
  });
});
