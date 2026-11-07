import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readDoc = (name: string) => readFile(new URL(`../src/content/docs/docs/${name}`, import.meta.url), 'utf8');

test('employee introduction offers repository-free work and real navigation labels', async () => {
  const overview = await readDoc('overview.mdx');
  const start = await readDoc('getting-started.md');
  const employees = await readDoc('employees.md');
  assert.match(overview, /title: AI employees/);
  assert.match(overview, /artifact workspace/i);
  assert.match(start, /\*\*Artifact workspace\*\*/);
  assert.match(start, /without requiring a GitHub repository/);
  assert.match(employees, /\*\*Agents\*\*/);
  assert.match(employees, /\*\*Launch bot\*\*/);
  for (const name of ['overview.mdx', 'getting-started.md', 'employees.md', 'dashboard.md', 'product-status.md']) {
    assert.doesNotMatch(await readDoc(name), /Every task needs a repository|non-code tasks use a repository too|Open \*\*Bots\*\*/i, name);
  }
});

test('run approval and publication approval stay distinct in user guides', async () => {
  for (const name of ['approval-gates.mdx', 'getting-started.md', 'dashboard.md', 'github.md', 'review.md', 'review-reference.md']) {
    assert.match(await readDoc(name), /separate (?:`pr_publish` approval|publication approval)/i, name);
  }
  assert.doesNotMatch(await readDoc('review.md'), /approval covers the task, its pull request/);
});

test('skills distinguish account storage, instruction skills and reviewed run versions', async () => {
  const skills = await readDoc('skills.md');
  assert.match(skills, /signed-in account or selected workspace/);
  assert.match(skills, /\*\*Run-attached skills\*\*/);
  assert.match(skills, /\*\*Mark reviewed\*\*/);
  assert.match(skills, /\*\*Activate reviewed version\*\*/);
  assert.match(skills, /\*\*Import legacy skills as drafts\*\*/);
  assert.doesNotMatch(skills, /Skills are saved in this browser/);
});

test('connections explain availability without enabling disabled operator execution', async () => {
  const connections = await readDoc('connections.md');
  assert.match(connections, /OpenConnector/);
  assert.match(connections, /\*\*Tool policy\*\*/);
  assert.match(connections, /API-key\/custom-account execution.*remains disabled/);
  assert.match(connections, /review-only enrollment is not permission to execute/);
  assert.match(connections, /preset is a starting configuration/);
});

test('sidebar and machine-readable introduction share the employee-first journey', async () => {
  const config = await readFile(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  const llms = await readFile(new URL('../src/pages/llms.txt.ts', import.meta.url), 'utf8');
  assert.match(config, /label: 'Work with AI employees'/);
  for (const path of ['employees', 'templates', 'connections']) assert.ok(config.includes(`/docs/${path}/`));
  assert.match(config, /label: 'Developer reference', collapsed: true/);
  assert.match(llms, /artifact workspaces create reviewable files without a repository/i);
  assert.doesNotMatch(llms, /a GitHub repository is required even for non-code drafts/);
});
