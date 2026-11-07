import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { INTEGRATION_CATALOG } from '../../../packages/shared/src/integration-catalog.ts';
import { integrationLogos } from '../../../packages/shared/src/integration-logos.ts';
import { plannedTools } from '../src/data/planned-integrations.ts';

test('all branded catalog entries resolve to locally shipped marks', () => {
  const generic = new Set(['shiba-mailbox', 'generic-webhook', 'external-mcp', 'brand-kit-canvases']);
  for (const entry of INTEGRATION_CATALOG) {
    const logos = integrationLogos(entry.id);
    if (!generic.has(entry.id)) assert.ok(logos.length, entry.id);
    for (const logo of logos) {
      assert.ok(existsSync(new URL(`../public${logo.src}`, import.meta.url)), logo.src);
    }
  }
  for (const tool of plannedTools) {
    for (const logo of integrationLogos(tool.name)) {
      assert.ok(existsSync(new URL(`../public${logo.src}`, import.meta.url)), logo.src);
    }
  }
});
