import { execFileSync } from 'node:child_process';
import { getCollection } from 'astro:content';
import { getPublishedPosts } from '../lib/journal';

const SITE = 'https://tryshiba.dev';
const day = (d: Date) => d.toISOString().slice(0, 10);

// Last commit date of a source file; shallow CI clones collapse to HEAD's date, never throws.
function gitDay(file: string): string {
	try {
		const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim();
		if (out) return out.slice(0, 10);
	} catch {}
	return day(new Date());
}

export async function GET() {
	const docs = await getCollection('docs');
	const posts = await getPublishedPosts();
	const postDay = (p: (typeof posts)[number]) => day(p.data.updatedDate ?? p.data.pubDate);
	const newest = (ps: typeof posts) => ps.map(postDay).sort().at(-1) ?? gitDay('src/pages/blog/index.astro');

	const entries: Array<{ path: string; lastmod: string }> = [
		{ path: '/', lastmod: gitDay('src/pages/index.astro') },
		{ path: '/llms.txt', lastmod: gitDay('public/llms.txt') },
		{ path: '/why-shiba/', lastmod: gitDay('src/pages/why-shiba.astro') },
		{ path: '/open-source-devin-alternative/', lastmod: gitDay('src/pages/open-source-devin-alternative.astro') },
		{ path: '/waitlist/', lastmod: gitDay('src/pages/waitlist.astro') },
		{ path: '/blog/', lastmod: newest(posts) },
		{ path: '/privacy/', lastmod: gitDay('src/pages/privacy.astro') },
		{ path: '/terms/', lastmod: gitDay('src/pages/terms.astro') },
	];

	// /blog/category/<c>/ only builds for categories that have posts.
	for (const category of new Set(posts.map((p) => p.data.category))) {
		entries.push({ path: `/blog/category/${category}/`, lastmod: newest(posts.filter((p) => p.data.category === category)) });
	}
	for (const post of posts) entries.push({ path: `/blog/${post.id}/`, lastmod: postDay(post) });
	for (const d of docs.filter((d) => d.id !== '404')) {
		entries.push({
			path: ('/' + d.id.replace(/(^|\/)index$/, '') + '/').replace(/\/+/g, '/'),
			lastmod: d.filePath ? gitDay(d.filePath) : day(new Date()),
		});
	}

	const unique = new Map<string, string>();
	for (const e of entries) if (!e.path.startsWith('/404') && !unique.has(e.path)) unique.set(e.path, e.lastmod);

	const urls = [...unique]
		.map(([path, lastmod]) => `  <url>\n    <loc>${SITE}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`)
		.join('\n');

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
		{ headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
	);
}
