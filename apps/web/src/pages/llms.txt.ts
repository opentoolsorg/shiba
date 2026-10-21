import { getCollection } from "astro:content";
import { CATEGORY_LABEL, getPublishedPosts } from "../lib/journal";

const SITE = "https://tryshiba.dev";

export async function GET() {
	const docs = (await getCollection("docs")).filter((d) => d.id.startsWith("docs/"));
	const links = docs
		.map((d) => `- [${d.data.title}](${SITE}/${d.id}/)${d.data.description ? `: ${d.data.description}` : ""}`)
		.join("\n");
	const posts = await getPublishedPosts();
	const postLinks = posts
		.map(
			(p) =>
				`- [${p.data.title}](${SITE}/blog/${p.id}/) (${CATEGORY_LABEL[p.data.category]}): ${p.data.description}`,
		)
		.join("\n");

	const body = `# Shiba

> Shiba is a free, open-source, self-hosted AI coding agent on Cloudflare: you approve every task, it runs in an isolated sandbox, you review the diff and ship a PR.

- Who it is for: developers and teams who want a self-hosted, approval-gated alternative to managed cloud coding agents like Devin, running in their own Cloudflare account.
- Pricing: free and open source (AGPL-3.0-only). You pay your own Cloudflare and model-provider costs.
- Status: early prototype, not production-ready. The homepage roadmap lists what is not live-verified.
- Supported harnesses: OpenCode, Claude Code, Codex, Devin CLI, Cursor, Antigravity, Grok.
- Maintainer: Prince Pal (https://github.com/princepal9120)

## Links

- Website: ${SITE}/
- Docs: ${SITE}/docs/overview/
- GitHub source (AGPL-3.0-only): https://github.com/princepal9120/shiba
- Shiba vs Devin / managed cloud agents (comparison table): ${SITE}/#compare-title
- Open-source Devin alternative guide: ${SITE}/open-source-devin-alternative/
- Why I am building Shiba: ${SITE}/why-shiba/
- Journal (guides and engineering notes): ${SITE}/blog/
- Join waitlist & contribute: ${SITE}/waitlist/

## Core Architecture & Security

- Edge Orchestrator: Cloudflare Workers + Agents SDK (TypeScript) routing requests at the edge.
- Sandbox containers: Cloudflare Sandbox SDK + Containers provide isolated Linux containers per task.
- Credentials: Provider credentials are added by Worker-side egress handling and are not passed into the sandbox process.
- State & Memory: Cloudflare Durable Objects + SQLite for human approval queues, live logs, and Vectorize for long-term memory.
- Access: Designed to sit behind operator-configured Cloudflare Access for dashboard and runner endpoints.

## Documentation

${links}
${
	posts.length > 0
		? `
## Journal

Long-form guides and engineering notes. Opinionated prose, same product claims as the docs.

${postLinks}
`
		: ""
}
`;

	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
