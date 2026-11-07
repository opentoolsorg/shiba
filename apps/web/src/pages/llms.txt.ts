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

> AI employees for the work behind your company. Give an employee a role and a task, provide context, approve workspace execution, and review the result.

- Audience: solo builders and teams working across engineering, design, marketing, sales, operations, finance, research, and revenue planning.
- Example outputs: a code change, design specification, campaign draft, account brief, operating checklist, pipeline summary, or draft budget using supplied figures.
- Roles: use built-in employee templates or custom instructions. Roles and skills guide work; they do not grant connected service access. The dashboard manages employee profiles under Agents.
- Execution: artifact workspaces create reviewable files without a repository. Repository tasks use GitHub. Employee tools and supplied context use linked briefs or explicitly granted app resources. Workspace runs require exact-request human approval; pull request publication requires a separate approval of the completed changes.
- Finance and revenue: draft analysis from supplied information, not bookkeeping sync, payroll, payments, autonomous CRM updates, or guaranteed financial outcomes.
- Ownership and costs: free, open-source software (AGPL-3.0-only). Hosting and model usage are paid to the configured providers. No free managed plan is offered.
- Connections: model accounts, app accounts, and employee tool permissions are separate. OpenConnector catalog listings and MCP presets are not proof of connected accounts or live vendor acceptance. General API-key/custom-account execution in the OpenConnector operator path remains disabled.
- Skills: current instruction skills and versioned run-attached skills are account- or workspace-scoped. Run-attached drafts need explicit review and activation; legacy browser-local notes can be imported as drafts.
- Status: under active development. Supported connections still need validation in the installation; see ${SITE}/docs/readiness/ for current verification limits.
- Maintainer: Prince Pal (https://github.com/princepal9120)

## Links

- Website: ${SITE}/
- Docs: ${SITE}/docs/overview/
- GitHub source (AGPL-3.0-only): https://github.com/opentoolsorg/shiba
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
