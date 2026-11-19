# Shiba brand mark

One drawing, generated rasters. Sources:

- `shiba-mark.svg` — the mark alone in a padded 64×64 box. This is the
  geometry of the public marketing mark
  (`apps/web/public/landing/shiba-mark.svg`, same path data, different
  viewBox padding) and what `apps/frontend/src/components/ShibaMark.tsx`
  draws. Use it for inline UI marks, favicons and OG images.
- `shiba-mark-tile.svg` — the app-icon plate: cream paper (--paper), a 14%
  navy hairline, the mark at 70% of the plate height. Use it for PWA, Apple
  touch, Electron and tray sources.

Palette (do not add colours): fur `#c4a574`, inner ear `#947544`
(fur − 48 per channel), visor `#14161c`, visor highlight `#2c3548`,
eyes `#f4fffc`, plate `#f6f4ed`, hairline `#0000a8` at 14%.

Rasters in `apps/frontend/public/app/`: `icon-192.png`, `icon-512.png`,
`icon-maskable-512.png` (mark at 46% for the maskable safe zone),
`apple-touch-icon.png` (180, full-bleed square — iOS applies its own mask),
`favicon-32x32.png`, `favicon.ico` (16/32/48), and `favicon.svg` (the bare
mark). Electron: `apps/desktop/assets/icon.png` (1024), `icon.icns`,
`trayTemplate.png`/`@2x` (macOS menu bar silhouette) and `tray.png`/`@2x`
(colour tray for Windows and Linux).
