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

> AI employees for the work behind your company. Describe a task, review the proposed action, approve repository execution, and inspect the files and changes returned.

- Audience: solo builders and teams working across engineering, design, marketing, sales, operations, finance, research, and revenue planning.
- Example outputs: a code change, design specification, campaign draft, account brief, operating checklist, pipeline summary, or draft budget using supplied figures.
- Roles: Engineering, Marketing, Research, and Operations have built-in templates in this branch. Other responsibilities use custom employee instructions. Roles do not grant connected service access.
- Execution: a GitHub repository is required even for non-code drafts. Human approval covers the exact requested work; external publishing is a separate supported/configured action.
- Finance and revenue: draft analysis from supplied information, not bookkeeping sync, payroll, payments, autonomous CRM updates, or guaranteed financial outcomes.
- Ownership and costs: free, open-source software (AGPL-3.0-only). Hosting and model usage are paid to the configured providers. No free managed plan is offered.
- Status: under active development. Supported connections still need validation in the installation; see ${SITE}/docs/readiness/ for current verification limits.
- Maintainer: Prince Pal (https://github.com/princepal9120)

## Links

- Website: ${SITE}/
- Docs: ${SITE}/docs/overview/
- GitHub source (AGPL-3.0-only): https://github.com/princepal9120/shiba
- Open-source Devin alternative guide: ${SITE}/open-source-devin-alternative/
- Why I am building Shiba: ${SITE}/why-shiba/
- Integrations (availability and configuration): ${SITE}/integrations/
- How work moves through Shiba: ${SITE}/network/
- Journal (building notes and guides): ${SITE}/blog/
- Join waitlist & contribute: ${SITE}/waitlist/
- Privacy notice: ${SITE}/privacy/
- Terms of use: ${SITE}/terms/

## Installation and security

- Edge Orchestrator: Cloudflare Workers + Agents SDK (TypeScript) routing requests at the edge.
- Sandbox containers: Cloudflare Sandbox SDK + Containers provide isolated Linux containers per task.
- Credentials: Supported provider-backed execution uses Worker-side egress authorization. Review the authentication-mode limits in ${SITE}/docs/configuration/ and ${SITE}/docs/security/ before choosing a connection.
- State & Memory: Cloudflare Durable Objects + SQLite for human approval queues, live logs, and Vectorize for long-term memory.
- Access: Designed to sit behind operator-configured Cloudflare Access for dashboard and runner endpoints.

## Documentation

${links}
${
	posts.length > 0
		? `
## Journal

Building notes and guides. Dated articles describe the product and evidence available when they were written.

${postLinks}
`
		: ""
}
`;

	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
