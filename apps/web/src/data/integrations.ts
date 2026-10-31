// Catalog claims are bounded by readiness.md and the dated VERIFICATION.md.
// Implemented/tested does not mean a live, provider-backed integration passed.
export const integrationGroups = [
  { id: 'triggers', name: 'Start work', description: 'Bring a task from a conversation, a schedule, or your own tools.' },
  { id: 'code', name: 'Repository', description: 'Work against a repository you control, with reviewable changes.' },
  { id: 'agents', name: 'AI tools', description: 'Choose the configured AI tool that will carry out the approved task.' },
  { id: 'infrastructure', name: 'Workspace hosting', description: 'Run the underlying services in your own Cloudflare account.' },
] as const;

type Integration = {
  name: string;
  monogram: string;
  logo?: string;
  group: (typeof integrationGroups)[number]['id'];
  description: string;
  status: 'Shipped' | 'Needs live verification';
  verification: string;
  docs: string;
  evidence: string[];
};

const readiness = 'apps/web/src/content/docs/docs/readiness.md';
const verification = 'VERIFICATION.md';

export const integrations: Integration[] = [
  {
    name: 'Slack', monogram: 'Sl', logo: '/assets/channels/slack.svg', group: 'triggers',
    description: 'Send a task from a mention, direct message, or /shiba command, then approve it in the conversation.',
    status: 'Needs live verification', verification: 'Signed approval exercised locally; live workspace acceptance is pending.', docs: '/docs/slack/',
    evidence: [readiness, verification, 'apps/backend/src/trigger.ts', 'apps/web/src/content/docs/docs/slack.mdx'],
  },
  {
    name: 'Telegram', monogram: 'Tg', logo: '/assets/channels/telegram.svg', group: 'triggers',
    description: 'Send a task to the bot and approve it with the buttons in your chat.',
    status: 'Needs live verification', verification: 'Webhook and approval tests exist; live chat remains unverified.', docs: '/docs/telegram/',
    evidence: [readiness, verification, 'apps/backend/src/telegram.ts', 'apps/web/src/content/docs/docs/telegram.mdx'],
  },
  {
    name: 'Discord', monogram: 'Di', logo: '/assets/channels/discord.svg', group: 'triggers',
    description: 'Start a task with /shiba and follow its progress in your channel.',
    status: 'Needs live verification', verification: 'Signature and approval tests exist; live chat remains unverified.', docs: '/docs/discord/',
    evidence: [readiness, verification, 'apps/backend/src/discord.ts', 'apps/web/src/content/docs/docs/discord.mdx'],
  },
  {
    name: 'Linear', monogram: 'Li', logo: '/assets/channels/linear.svg', group: 'triggers',
    description: 'Delegate an issue to Shiba, then open the workspace to review the requested work.',
    status: 'Needs live verification', verification: 'Webhook and mock session tests exist; live workspace acceptance is pending.', docs: '/docs/linear-agent-session/',
    evidence: [readiness, verification, 'apps/backend/src/linear.ts', 'apps/web/src/content/docs/docs/linear-agent-session.md'],
  },
  {
    name: 'Gmail', monogram: 'Gm', logo: '/assets/channels/gmail.svg', group: 'triggers',
    description: 'Use permitted email search results as context for a task.',
    status: 'Needs live verification', verification: 'Read-only grant flow implemented; live Google workspace acceptance is pending.', docs: '/docs/dashboard/',
    evidence: [readiness, verification, 'apps/frontend/src/components/GmailConnection.tsx'],
  },
  {
    name: 'MCP clients', monogram: 'MC', group: 'triggers',
    description: 'Request work and read task status from a supported AI app. A human still approves the proposed run.',
    status: 'Needs live verification', verification: 'Token/OAuth and tool tests exist; a live client round trip is pending.', docs: '/docs/mcp/',
    evidence: [readiness, verification, 'apps/backend/src/oauth-mcp.ts', 'apps/web/src/content/docs/docs/mcp.md'],
  },
  {
    name: 'Cron & automations', monogram: 'Cr', group: 'triggers',
    description: 'Request work on a schedule or when a connected service sends an event.',
    status: 'Needs live verification', verification: 'Trigger and safety logic is tested, not cloud-live accepted.', docs: '/docs/automations/',
    evidence: [readiness, verification, 'apps/backend/src/v1/automations.ts', 'apps/web/src/content/docs/docs/automations.md'],
  },
  {
    name: 'Shiba CLI', monogram: '>_', group: 'triggers',
    description: 'Set up and explore a local Shiba workspace from your terminal.',
    status: 'Needs live verification', verification: 'Setup checks exist; the latest first-run entry records no live Worker CLI launch.', docs: '/docs/local-development/',
    evidence: [readiness, verification, 'scripts/shiba.mjs', 'apps/web/src/content/docs/docs/getting-started.md'],
  },
  {
    name: 'Dashboard', monogram: 'UI', logo: '/assets/mascot/pet-logo.png', group: 'triggers',
    description: 'Give an employee a brief, approve the proposed task, and review the files it returns.',
    status: 'Needs live verification', verification: 'Local browser checks exist; they do not establish a cloud end-to-end run.', docs: '/docs/dashboard/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/dashboard.md'],
  },
  {
    name: 'GitHub', monogram: 'GH', logo: '/assets/channels/github.svg', group: 'code',
    description: 'Give the task a working context and a place for files, from code changes to campaign drafts and budget notes.',
    status: 'Needs live verification', verification: 'Local clone evidence exists; live PR publication is not established.', docs: '/docs/github/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/github.md', 'apps/backend/src/github.ts'],
  },
  {
    name: 'OpenCode', monogram: 'Oc', logo: '/assets/harnesses/opencode.svg', group: 'agents',
    description: 'Use OpenCode to carry out approved work in the task repository.',
    status: 'Needs live verification', verification: 'Launched locally; the recorded provider request returned 401, not inference.', docs: '/docs/agents/opencode/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/agents/opencode.mdx'],
  },
  {
    name: 'Claude Code', monogram: 'Cc', logo: '/assets/harnesses/claude.svg', group: 'agents',
    description: 'Choose Claude Code as the agent for an approved task.',
    status: 'Needs live verification', verification: 'Configuration and parsers are tested; no accepted live provider run is recorded.', docs: '/docs/agents/claude-code/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/agents/claude-code.mdx'],
  },
  {
    name: 'Codex', monogram: 'Cx', logo: '/assets/harnesses/openai.svg', group: 'agents',
    description: 'Choose Codex as the agent for an approved task.',
    status: 'Needs live verification', verification: 'Configuration and parsers are tested; live provider acceptance is pending.', docs: '/docs/agents/codex/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/agents/codex.mdx'],
  },
  {
    name: 'Model providers', monogram: 'AI', group: 'agents',
    description: 'Connect a supported AI model through your own account.',
    status: 'Needs live verification', verification: 'Provider routing is implemented; successful model inference is not established.', docs: '/docs/configuration/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/configuration.md'],
  },
  {
    name: 'Cloudflare Workers', monogram: 'Wk', group: 'infrastructure',
    description: 'Host the workspace and receive requests from your connected tools.',
    status: 'Needs live verification', verification: 'Local checks and dry runs are not cloud end-to-end acceptance.', docs: '/docs/architecture/',
    evidence: [readiness, verification, 'apps/backend/wrangler.jsonc', 'apps/web/src/content/docs/docs/architecture.md'],
  },
  {
    name: 'Sandbox & Containers', monogram: 'Sb', group: 'infrastructure',
    description: 'Provide the environment where approved repository work takes place.',
    status: 'Needs live verification', verification: 'Local container execution exists; a cloud coding journey remains unverified.', docs: '/docs/sandbox-providers/',
    evidence: [readiness, verification, 'apps/backend/wrangler.jsonc', 'apps/web/src/content/docs/docs/architecture.md'],
  },
  {
    name: 'Durable Objects', monogram: 'DO', group: 'infrastructure',
    description: 'Keep task progress and approval decisions together.',
    status: 'Needs live verification', verification: 'Local dispatch is exercised; cloud eviction and resume acceptance is pending.', docs: '/docs/architecture/',
    evidence: [readiness, verification, 'apps/backend/wrangler.jsonc', 'apps/web/src/content/docs/docs/architecture.md'],
  },
  {
    name: 'D1', monogram: 'D1', group: 'infrastructure',
    description: 'Store account records and activity history for the installation.',
    status: 'Needs live verification', verification: 'Binding and storage code exist; account-owned acceptance is still required.', docs: '/docs/architecture/#source-map',
    evidence: [readiness, verification, 'apps/backend/wrangler.jsonc', 'apps/web/src/content/docs/docs/architecture.md'],
  },
  {
    name: 'Workers KV', monogram: 'KV', group: 'infrastructure',
    description: 'Store access records for configured clients.',
    status: 'Needs live verification', verification: 'Token storage has tests; live authenticated client acceptance is pending.', docs: '/docs/architecture/#source-map',
    evidence: [readiness, verification, 'apps/backend/src/oauth-mcp.ts', 'apps/web/src/content/docs/docs/architecture.md'],
  },
  {
    name: 'Vectorize', monogram: 'Vx', group: 'infrastructure',
    description: 'Support the configured memory features for recalling relevant context.',
    status: 'Needs live verification', verification: 'Bound in the deployment; live Vectorize behavior is explicitly unverified.', docs: '/docs/architecture/#source-map',
    evidence: [readiness, verification, 'apps/backend/wrangler.jsonc', 'apps/web/src/content/docs/docs/architecture.md'],
  },
  {
    name: 'Cloudflare Access', monogram: 'Ac', group: 'infrastructure',
    description: 'Control who can open the workspace through your identity provider.',
    status: 'Needs live verification', verification: 'Forged headers were rejected in a deployed check; full account acceptance is pending.', docs: '/docs/security/',
    evidence: [readiness, verification, 'apps/web/src/content/docs/docs/architecture.md'],
  },
];
