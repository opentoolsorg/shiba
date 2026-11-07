import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { INTEGRATION_CATALOG } from '../../../packages/shared/src/integration-catalog.ts';
import { CURATED_MCP_VENDORS } from '../../../packages/shared/src/curated-mcp-vendors.ts';
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
  for (const vendor of CURATED_MCP_VENDORS) {
    assert.ok(integrationLogos(vendor.catalogId).length, vendor.catalogId);
  }
  for (const tool of plannedTools) {
    for (const logo of integrationLogos(tool.name)) {
      assert.ok(existsSync(new URL(`../public${logo.src}`, import.meta.url)), logo.src);
    }
  }
});


test('standalone SVG brand assets include nonempty accessible titles', () => {
  const directory = new URL('../public/integration-logos/', import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith('.svg'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const svg = readFileSync(new URL(file, directory), 'utf8');
    assert.match(svg, /<title>[^<]+<\/title>/, file);
  }
});
