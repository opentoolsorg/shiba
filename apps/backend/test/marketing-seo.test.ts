import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "..", "web", "dist");
const built = existsSync(join(dist, "index.html"));

function walkHtml(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith("_") || entry.name === "pagefind") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkHtml(path, `${prefix}${entry.name}/`));
		else if (entry.name === "index.html") out.push(`/${prefix}`);
	}
	return out;
}

describe.skipIf(!built)("marketing SEO (built dist)", () => {
	const page = (rel: string) => readFileSync(join(dist, rel), "utf8");

	it("robots.txt points at sitemap.xml and blocks app/api", () => {
		const robots = readFileSync(join(dist, "robots.txt"), "utf8");
		expect(robots).toContain("Sitemap: https://tryshiba.dev/sitemap.xml");
		expect(robots).toMatch(/Disallow: \/api\//);
		expect(robots).toMatch(/Disallow: \/app\//);
	});

	it("custom sitemap lists every public HTML page with trailing-slash canonicals", () => {
		const sitemap = page("sitemap.xml");
		const locs = [...sitemap.matchAll(/<loc>https:\/\/tryshiba\.dev([^<]*)<\/loc>/g)].map((m) => m[1]);
		// Redirects and private design previews are deliberately noindex.
		const htmlPaths = walkHtml(dist).filter((path) => {
			const html = page(join(path.slice(1), "index.html"));
			return !/<meta\b[^>]*name="robots"[^>]*content="[^"]*\bnoindex\b/i.test(html);
		});
		const missing = htmlPaths.filter((path) => !locs.includes(path));
		expect(missing).toEqual([]);
		for (const loc of locs) {
			expect(loc).toBeDefined();
			if (loc && loc !== "/") expect(loc.endsWith("/")).toBe(true);
		}
	});

	it("homepage omits BreadcrumbList; docs overview includes it", () => {
		const home = page("index.html");
		expect(home).not.toContain('"@type":"BreadcrumbList"');
		const overview = page("docs/overview/index.html");
		expect(overview).toContain('"@type":"BreadcrumbList"');
		const schemas = [...overview.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
			.map((match) => JSON.parse(match[1] ?? "null"));
		const breadcrumb = schemas.find((schema) => schema?.["@type"] === "BreadcrumbList");
		expect(breadcrumb?.itemListElement).toEqual([
			{ "@type": "ListItem", position: 1, name: "Home", item: "https://tryshiba.dev/" },
			{ "@type": "ListItem", position: 2, name: "AI employees at a glance", item: "https://tryshiba.dev/docs/overview/" },
		]);
		expect(overview).toContain("og:image");
		expect(overview).toContain("twitter:image");
	});

	it("llms.txt links key marketing and legal pages", () => {
		const llms = page("llms.txt");
		expect(llms).toContain("https://tryshiba.dev/privacy/");
		expect(llms).toContain("https://tryshiba.dev/terms/");
		expect(llms).toContain("https://tryshiba.dev/why-shiba/");
	});
});
