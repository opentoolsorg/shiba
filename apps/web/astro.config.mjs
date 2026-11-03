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
  sidebar: { items: [{ autogenerate: { collection: 'docs' } }] },
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
