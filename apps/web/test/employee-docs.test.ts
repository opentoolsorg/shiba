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
  assert.match(start, /GitHub repository/);
  assert.match(employees, /\*\*Agents\*\*/);
  assert.match(employees, /\*\*Launch bot\*\*/);
  for (const name of ['overview.mdx', 'getting-started.md', 'employees.md', 'dashboard.md', 'product-status.md']) {
    const source = await readDoc(name);
    assert.doesNotMatch(source, /Every task needs a repository|non-code tasks use a repository too|Open \*\*Bots\*\*/i, name);
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
  assert.match(connections, /API-key\/custom-account execution/i);
  assert.match(connections, /review-only enrollment/i);
  assert.match(connections, /starting configuration/i);
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

test('file guide separates capture, saved review, revision execution and signed downloads', async () => {
  const guide = await readDoc('artifacts.md');
  for (const label of ['Named deliverables', 'Artifact ZIP', 'Save review', 'Create revision approval', 'Version history']) {
    assert.ok(guide.includes(`**${label}**`), label);
  }
  assert.match(guide, /records your decision/i);
  assert.match(guide, /does not start another run/i);
  assert.match(guide, /Anyone with the complete ZIP link can download the archive/);
  assert.match(guide, /Up to 8 UTF-8/);
  assert.match(guide, /Up to 64 files/);
  assert.match(guide, /expire[s]? after seven days/);
});

test('memory guide explains private sources, bounded snapshots and deletion limits', async () => {
  const guide = await readDoc('context-and-memory.md');
  assert.match(guide, /\*\*OWNER PRIVATE\*\*/);
  assert.match(guide, /does not fetch/i);
  assert.match(guide, /40,000 bytes/);
  assert.match(guide, /360 characters per selected source/);
  assert.match(guide, /approved snapshots remain unchanged/i);
  assert.match(guide, /uploaded files remain stored until deletion/i);
  assert.match(guide, /\*\*Apply project defaults\*\*/);
});

test('auth references keep standard SIWC credentials on the Worker', async () => {
  for (const name of ['model-auth.md', 'configuration.md']) {
    const source = await readDoc(name);
    assert.match(source, /ACCESS_TOKEN=shiba-egress-placeholder/, name);
    assert.match(source, /SHIBA_CODEX_DEVICE_AUTH=1/, name);
    assert.doesNotMatch(source, /mounts real `auth.json`|only a ~1h|exchange\/refresh must move into the sandbox|CLI refreshes from the container/, name);
  }
  const security = await readDoc('security.md');
  assert.match(security, /Better Auth/);
  assert.match(security, /Every allowed workspace run requires human approval/);
  assert.doesNotMatch(security, /Unattended mode is opt-in and narrow/);
});

test('automation and limits guides distinguish dispatch policy from billing and UI state', async () => {
  const guide = await readDoc('automations.md');
  const reference = await readDoc('automation-reference.md');
  const limits = await readDoc('runtime-limits.md');
  assert.match(guide, /\*\*Disable\*\*/);
  assert.match(guide, /does not cancel.*request already queued/i);
  assert.match(guide, /trigger already being evaluated/i);
  assert.match(guide, /late-arriving approvals/i);
  assert.match(reference, /TypeSafe Noul/);
  assert.match(reference, /before the coding-run approval is queued/);
  assert.match(reference, /issue titles and bodies are not included/i);
  assert.match(reference, /only schedule triggers are accepted/);
  assert.match(limits, /harness reported/);
  assert.match(limits, /positive finite number/i);
  assert.match(limits, /unreported|no reported cost/);
  assert.match(limits, /100,000 bytes/);
  assert.doesNotMatch(limits, /Capture truncation can make publication incomplete|configured container instances \| 5/);
});

test('deeper user guides are reachable from the primary navigation', async () => {
  const config = await readFile(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  for (const path of ['artifacts', 'context-and-memory', 'permissions']) assert.ok(config.includes(`/docs/${path}/`));
  const roles = await readDoc('permissions.md');
  assert.match(roles, /Deployment operator/);
  assert.match(roles, /Workspace owner or admin/);
  assert.match(roles, /MCP client identity/);
  assert.match(roles, /Room participant/);
});
