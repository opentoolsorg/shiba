import { getCollection } from 'astro:content';
import { getPublishedPosts } from '../lib/journal';

const SITE = 'https://tryshiba.dev';
const day = (d: Date) => d.toISOString().slice(0, 10);

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET() {
	const docs = await getCollection('docs');
	const posts = await getPublishedPosts();
	const postDay = (p: (typeof posts)[number]) => day(p.data.updatedDate ?? p.data.pubDate);
	const newest = (ps: typeof posts) => ps.map(postDay).sort().at(-1);

	// Only dated editorial content has a verified modification date. Git history
	// can be missing or shallow in CI; never substitute a build date for lastmod.
	const entries: Array<{ path: string; lastmod?: string }> = [
		{ path: '/' },
		{ path: '/why-shiba/' },
		{ path: '/open-source-devin-alternative/' },
		{ path: '/waitlist/' },
		{ path: '/network/' },
		{ path: '/integrations/' },
		{ path: '/blog/', lastmod: newest(posts) },
		{ path: '/privacy/' },
		{ path: '/terms/' },
	];

	// Match the category template's noindex threshold for thin archives.
	for (const category of new Set(posts.map((p) => p.data.category))) {
		const categoryPosts = posts.filter((p) => p.data.category === category);
		if (categoryPosts.length < 2) continue;
		entries.push({ path: `/blog/category/${category}/`, lastmod: newest(categoryPosts) });
	}
	for (const post of posts) entries.push({ path: `/blog/${post.id}/`, lastmod: postDay(post) });
	for (const d of docs.filter((d) => d.id !== '404' && !d.data.draft)) {
		const path = ('/' + d.id.replace(/(^|\/)index$/, '') + '/').replace(/\/+/g, '/');
		// These aliases redirect to /docs/overview/ in the site configuration.
		if (path === '/docs/' || path === '/welcome/') continue;
		const excluded = d.data.head.some(({ tag, attrs }) =>
			(tag === 'meta' && typeof attrs?.name === 'string' && /^(robots|googlebot)$/i.test(attrs.name)
				&& typeof attrs.content === 'string' && /\b(noindex|none)\b/i.test(attrs.content))
			|| (tag === 'link' && attrs?.rel === 'canonical' && typeof attrs.href === 'string'
				&& new URL(attrs.href, new URL(path, SITE)).href !== new URL(path, SITE).href),
		);
		if (!excluded) entries.push({ path });
	}

	const unique = new Map<string, string | undefined>();
	for (const e of entries) if (e.path !== '/404/' && !unique.has(e.path)) unique.set(e.path, e.lastmod);

	const urls = [...unique]
		.map(([path, lastmod]) => `  <url>\n    <loc>${escapeXml(new URL(path, SITE).href)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`)
		.join('\n');

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
		{ headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
	);
}
