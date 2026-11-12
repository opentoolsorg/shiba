import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterPlanned, plannedCategories, plannedCategoryCounts, plannedTools } from '../src/data/planned-integrations.ts';

const names = (tools: { name: string }[]) => tools.map((t) => t.name);


test('24 planned tools in canvas order', () => {
  assert.deepEqual(names(plannedTools), [
    'Microsoft Teams', 'Baremetrics', 'Bright Data Social', 'Customer.io', 'DeepWiki', 'GitHub (Git & CLI)',
    'Google Ads', 'Google Drive', 'Granola', 'Jira & Confluence', 'Linear', 'Meta Ads', 'Monday.com', 'Moz SEO',
    'Neon', 'Notion', 'OneDrive', 'PayPal', 'PostHog', 'PostHog (EU)', 'QuickBooks', 'Salesforce', 'Sentry', 'Square',
  ]);

});

test('15 categories with canvas counts', () => {
  assert.deepEqual(plannedCategories, [
    'All', 'AI & Machine Learning', 'Analytics', 'Cloud & Data', 'Communication', 'Content & Media', 'Customer Support',
    'Developer Tools', 'E-Commerce', 'Finance & Payments', 'HR & Recruiting', 'Marketing', 'Other', 'Productivity', 'Sales & CRM',
  ]);
  assert.deepEqual(plannedCategoryCounts.map((c) => c.name), plannedCategories);
  assert.deepEqual(plannedCategoryCounts.map((c) => c.count), [24, 1, 3, 4, 1, 0, 0, 3, 0, 3, 0, 4, 0, 4, 1]);
  for (const { name, count } of plannedCategoryCounts) {
    const hits = filterPlanned(plannedTools, { category: name });
    assert.equal(hits.length, count, name);
    if (count === 0) assert.deepEqual(hits, []);
  }
});

test('trimmed, case-insensitive query ANDed with category', () => {
  assert.deepEqual(names(filterPlanned(plannedTools, { query: '  pOsThOg  ', category: 'All' })), ['PostHog', 'PostHog (EU)']);
  assert.equal(filterPlanned(plannedTools, { query: 'posthog', category: 'Analytics' }).length, 2);
  assert.equal(filterPlanned(plannedTools, { query: 'posthog', category: 'Marketing' }).length, 0);
  assert.deepEqual(names(filterPlanned(plannedTools, { query: '  gOoGlE  ' })), ['Google Ads', 'Google Drive']);
  assert.equal(filterPlanned(plannedTools, { query: '   ' }).length, 24);
  assert.equal(filterPlanned(plannedTools, { query: 'marketing' }).length, 4, 'category text is searchable');
});

test('brand identity stays tied to the tool name after filtering', async () => {
  const { integrationLogos } = await import('../../../packages/shared/src/integration-logos.ts');
  const logos = new Map(plannedTools.map((tool) => [tool.name, integrationLogos(tool.name)]));
  for (const category of plannedCategories) {
    for (const tool of filterPlanned(plannedTools, { category })) {
      assert.deepEqual(integrationLogos(tool.name), logos.get(tool.name));
    }
  }
  assert.equal(integrationLogos('PostHog (EU)')[0]?.src, integrationLogos('PostHog')[0]?.src);
});
