import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Assemble the Worker's ASSETS directory (public/) from package-local build
// outputs. Runs after `turbo run build`:
//   1. the dashboard client bundle — vite writes apps/frontend/dist/client
//      (and a dist/server bundle the Worker never serves);
//   2. the Astro docs/marketing site — apps/web/dist, copied second so it
//      wins on name collisions, the same ordering as when the frontend wrote
//      public/ directly.
// public/ is build output and is gitignored; turbo outputs stay inside each
// package (a package-relative glob can't cover this dir), so this root step
// is the merge point. public/ is rebuilt from scratch each run.
const root = new URL('..', import.meta.url);
const steps = [
  ['apps/frontend/dist/client', 'public'],
  ['apps/web/dist', 'public'],
];

const dest = new URL('public', root);
await rm(fileURLToPath(dest), { recursive: true, force: true });
await mkdir(fileURLToPath(dest), { recursive: true });

for (const [src, dst] of steps) {
  const srcUrl = new URL(`${src}/`, root);
  await cp(fileURLToPath(srcUrl), fileURLToPath(new URL(`${dst}/`, root)), {
    recursive: true,
    force: true,
  });
  console.log(`Copied ${src} -> ${dst}`);
}

// The Worker (app.tryshiba.dev) serves only the dashboard; public/ stays the Pages site.
// _redirects and blog/ are tryshiba.dev marketing files, so they never ship to the Worker.
const appSrc = fileURLToPath(new URL('apps/frontend/dist/client', root));
const appDest = fileURLToPath(new URL('app-public', root));
await rm(appDest, { recursive: true, force: true });
await cp(appSrc, appDest, {
  recursive: true,
  filter: (src) => !/^\/(_redirects|blog)(\/|$)/.test(src.slice(appSrc.length)),
});
console.log('Copied apps/frontend/dist/client -> app-public (Worker assets)');
