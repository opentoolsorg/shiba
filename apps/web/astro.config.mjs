// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import starlight from '@astrojs/starlight';

// Static site built to dist/ then merged into public/ (see scripts/assemble-public.mjs).
// Static output is Astro's default; no adapter, no SSR.
export default defineConfig({
	site: 'https://tryshiba.dev',
	srcDir: './src',
	outDir: 'dist',
	output: 'static',
	// sharp's native dep is unavailable in CI; marketing images ship as authored.
	image: { service: passthroughImageService() },
	redirects: {
		'/docs': '/docs/overview/',
		'/welcome': '/docs/overview/',
	},
	integrations: [
		tailwind({ applyBaseStyles: false }),
		starlight({
			title: 'Shiba',
			description:
				'AI employees for the work behind your company, from code and design to marketing, sales, operations and finance.',
			components: {
				Head: './src/components/starlight/Head.astro',
				Header: './src/components/starlight/Header.astro',
			},
			head: [
				{
					tag: 'link',
					attrs: { rel: 'sitemap', href: '/sitemap.xml' },
				},
				{
					tag: 'meta',
					attrs: { name: 'robots', content: 'index, follow, max-image-preview:large' },
				},
			],
			logo: {
				src: './src/assets/logo.png',
				alt: 'Shiba Logo',
			},
			favicon: '/favicon.ico',
			customCss: ['./src/styles/theme.css', './src/styles/docs-shell.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/opentoolsorg/shiba' },
			],
			editLink: {
				baseUrl: 'https://github.com/opentoolsorg/shiba/edit/main/apps/web/',
			},
			sidebar: [
                { label: 'Get started', items: [
                    { label: 'Welcome', slug: 'docs/overview' },
                    { label: 'Your first task', slug: 'docs/getting-started' },
                ] },
                { label: 'Work with Shiba', items: [
                    { label: 'Employees', slug: 'docs/employees' },
                    { label: 'Threads & results', slug: 'docs/dashboard' },
                    { label: 'Approvals', slug: 'docs/approval-gates' },
                    { label: 'Review changes', slug: 'docs/review' },
                    { label: 'Skills', slug: 'docs/skills' },
                    { label: 'Automations', slug: 'docs/automations' },
                ] },
                { label: 'Connections', items: [
                    { label: 'GitHub', slug: 'docs/github' },
                    { label: 'Slack', slug: 'docs/slack' },
                    { label: 'Linear', slug: 'docs/linear-agent-session' },
                    { label: 'Telegram', slug: 'docs/telegram' },
                    { label: 'Discord', slug: 'docs/discord' },
                    { label: 'Your computers', slug: 'docs/remote-access' },
                ] },
                { label: 'Help', items: [
                    { label: 'Common questions', slug: 'docs/troubleshooting' },
                    { label: 'Costs', slug: 'docs/costs' },
                    { label: 'Product status', slug: 'docs/product-status' },
                ] },
                { label: 'Set up a workspace', collapsed: true, items: [
                    { label: 'Self-host Shiba', slug: 'docs/self-hosting' },
                    { label: 'Setup walkthrough', slug: 'docs/onboarding' },
                    { label: 'Launch', slug: 'docs/launch' },
                    { label: 'Deployment', slug: 'docs/deployment' },
                    { label: 'Configuration', slug: 'docs/configuration' },
                    { label: 'Security & privacy', slug: 'docs/security' },
                    { label: 'Readiness checklist', slug: 'docs/readiness' },
                    { label: 'Computer setup', slug: 'docs/remote-access-setup' },
                    { label: 'GitHub setup', slug: 'docs/github-setup' },
                    { label: 'Slack setup', slug: 'docs/slack-setup' },
                    { label: 'Linear setup', slug: 'docs/linear-setup' },
                    { label: 'Telegram setup', slug: 'docs/telegram-setup' },
                    { label: 'Discord setup', slug: 'docs/discord-setup' },
                    { label: 'Runtime costs & limits', slug: 'docs/runtime-limits' },
                    { label: 'Compare hosted tools', slug: 'docs/hosted-alternatives' },
                ] },
                { label: 'Developer reference', collapsed: true, items: [
                    { label: 'API reference', slug: 'docs/api' },
                    { label: 'TypeScript SDK', slug: 'docs/sdk' },
                    { label: 'Task settings', slug: 'docs/task-settings' },
                    { label: 'Automation reference', slug: 'docs/automation-reference' },
                    { label: 'Review reference', slug: 'docs/review-reference' },
                    { label: 'Local development', slug: 'docs/local-development' },
                    { label: 'Architecture', slug: 'docs/architecture' },
                    { label: 'Implementation status', slug: 'docs/implementation-status' },
                    { label: 'Harnesses', slug: 'docs/claude-code' },
                    { label: 'Claude Code', slug: 'docs/agents/claude-code' },
                    { label: 'Codex', slug: 'docs/agents/codex' },
                    { label: 'OpenCode', slug: 'docs/agents/opencode' },
                    { label: 'MCP clients', slug: 'docs/mcp' },
                    { label: 'HTTP triggers', slug: 'docs/triggers' },
                    { label: 'Swarm desk', slug: 'docs/swarm-desk' },
                    { label: 'Sandbox providers', slug: 'docs/sandbox-providers' },
                    { label: 'Sandbox SDK', slug: 'docs/sandbox-sdk-1' },
                    { label: 'Sandbox costs', slug: 'docs/sandbox-cheapest-provider' },
                    { label: 'Custom sandbox provider', slug: 'docs/sandbox-custom-provider' },
                    { label: 'Contributing', slug: 'docs/contributing' },
                    { label: 'Waitlist operations', slug: 'docs/waitlist' },
                ] },
            ],
		}),
	],
});
