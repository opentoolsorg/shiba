import { readdir, readFile, access } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const content = fileURLToPath(new URL('../src/content/docs/', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
async function verifyPages(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await verifyPages(path);
    else if (/\.mdx?$/.test(entry.name) && entry.name !== '404.md') {
      const slug = relative(content, path).slice(0, -extname(path).length);
      await access(join(dist, slug, 'index.html'));
      await access(join(dist, slug, 'index.md'));
    }
  }
}
await verifyPages(content);
for (const file of ['index.html', 'docs/overview/index.html', 'reference/api/index.html', 'reference/api/get/threads/index.md', 'llms.txt', 'pagefind/pagefind.js']) await access(join(dist, file));
const landing = await readFile(join(dist, 'index.html'), 'utf8');
if (!landing.includes('AI Employees for the Work Behind Your Company')) throw new Error('Landing page is missing its title');
console.log('Existing docs URLs, agent Markdown, API reference, search, and landing page are present.');
