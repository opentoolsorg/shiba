// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';
import tailwindcss from '@tailwindcss/vite';

const nimbusConfig = defineNimbusConfig({
  site: 'https://tryshiba.dev',
  title: 'Shiba',
  description: 'AI employees for the work behind your company.',
  github: 'https://github.com/opentoolsorg/shiba',
  api: [{ collection: 'api', spec: '../backend/src/v1/openapi.json' }],
  sidebar: { items: [
    { label: 'Get started', items: [{ label: 'AI employees at a glance', link: '/docs/overview/' }, { label: 'Give your first task', link: '/docs/getting-started/' }] },
    { label: 'Work with AI employees', items: [{ label: 'AI employees', link: '/docs/employees/' }, { label: 'Employee templates', link: '/docs/templates/' }, { label: 'Threads & results', link: '/docs/dashboard/' }, { label: 'Files & revisions', link: '/docs/artifacts/' }, { label: 'Context & memory', link: '/docs/context-and-memory/' }, { label: 'Approvals', link: '/docs/approval-gates/' }, { label: 'Permissions & roles', link: '/docs/permissions/' }, { label: 'Review changes', link: '/docs/review/' }, { label: 'Work with your team', link: '/docs/team-workspaces/' }, { label: 'Skills', link: '/docs/skills/' }, { label: 'Automations', link: '/docs/automations/' }] },
    { label: 'Connections', items: [{ label: 'Connections & tools', link: '/docs/connections/' }, { label: 'GitHub', link: '/docs/github/' }, { label: 'Slack', link: '/docs/slack/' }, { label: 'Linear', link: '/docs/linear-agent-session/' }, { label: 'Telegram', link: '/docs/telegram/' }, { label: 'Discord', link: '/docs/discord/' }, { label: 'Your computers', link: '/docs/remote-access/' }] },
    { label: 'Help', items: [{ label: 'Common questions', link: '/docs/troubleshooting/' }, { label: 'Costs', link: '/docs/costs/' }, { label: 'Product status', link: '/docs/product-status/' }] },
    { label: 'Set up a workspace', collapsed: true, items: [{ label: 'Self-host Shiba', link: '/docs/self-hosting/' }, { label: 'Setup walkthrough', link: '/docs/onboarding/' }, { label: 'Launch', link: '/docs/launch/' }, { label: 'Deployment', link: '/docs/deployment/' }, { label: 'Configuration', link: '/docs/configuration/' }, { label: 'Security & privacy', link: '/docs/security/' }, { label: 'Readiness checklist', link: '/docs/readiness/' }, { label: 'Computer setup', link: '/docs/remote-access-setup/' }, { label: 'GitHub setup', link: '/docs/github-setup/' }, { label: 'Slack setup', link: '/docs/slack-setup/' }, { label: 'Linear setup', link: '/docs/linear-setup/' }, { label: 'Telegram setup', link: '/docs/telegram-setup/' }, { label: 'Discord setup', link: '/docs/discord-setup/' }, { label: 'Runtime costs & limits', link: '/docs/runtime-limits/' }] },
    { label: 'Developer reference', collapsed: true, items: [{ label: 'API reference', link: '/docs/api/' }, { label: 'TypeScript SDK', link: '/docs/sdk/' }, { label: 'Task settings', link: '/docs/task-settings/' }, { label: 'Automation reference', link: '/docs/automation-reference/' }, { label: 'Review reference', link: '/docs/review-reference/' }, { label: 'Local development', link: '/docs/local-development/' }, { label: 'Architecture', link: '/docs/architecture/' }, { label: 'Implementation status', link: '/docs/implementation-status/' }, { label: 'Harnesses', link: '/docs/claude-code/' }, { label: 'Claude Code', link: '/docs/agents/claude-code/' }, { label: 'Codex', link: '/docs/agents/codex/' }, { label: 'OpenCode', link: '/docs/agents/opencode/' }, { label: 'MCP clients', link: '/docs/mcp/' }, { label: 'HTTP triggers', link: '/docs/triggers/' }, { label: 'Swarm desk', link: '/docs/swarm-desk/' }, { label: 'Sandbox providers', link: '/docs/sandbox-providers/' }, { label: 'Sandbox SDK', link: '/docs/sandbox-sdk-1/' }, { label: 'Sandbox costs', link: '/docs/sandbox-cheapest-provider/' }, { label: 'Custom sandbox provider', link: '/docs/sandbox-custom-provider/' }, { label: 'Contributing', link: '/docs/contributing/' }, { label: 'Waitlist operations', link: '/docs/waitlist/' }] },
    { label: "More guides", collapsed: true, items: ['docs/model-auth'] }
  ] },
});

// Static site built to dist/ then merged into public/ (see scripts/assemble-public.mjs).
// Static output is Astro's default; no adapter, no SSR.
export default defineConfig({
	site: 'https://tryshiba.dev',
	srcDir: './src',
	vite: { plugins: [tailwindcss()] },
	outDir: 'dist',
	output: 'static',
	// sharp's native dep is unavailable in CI; marketing images ship as authored.
	image: { service: passthroughImageService() },
	redirects: {
		'/docs': '/docs/overview/',
		'/welcome': '/docs/overview/',
	},
	integrations: [
        nimbus(nimbusConfig, { markdown: { hastPlugins: [tableScroll()] } }),
	],
});
