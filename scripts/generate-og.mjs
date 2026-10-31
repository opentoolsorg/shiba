#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

const require = createRequire(import.meta.url);
const playwrightPath = require.resolve('playwright-core', {
  paths: [rootDir, resolve(rootDir, 'apps/desktop')],
});
const pw = await import(playwrightPath);
const chromium = pw.chromium || pw.default?.chromium;

const logoPath = resolve(rootDir, 'apps/web/public/assets/mascot/pet-logo.png');
const logoBase64 = readFileSync(logoPath).toString('base64');
const logoDataUri = `data:image/png;base64,${logoBase64}`;

const outputPath = resolve(rootDir, 'apps/web/public/assets/og/shiba-og.png');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      width: 1200px;
      height: 630px;
      background: #141413;
      color: #eae8e1;
      font-family: 'Geist', -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      padding: 46px 72px 48px;
      position: relative;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    body::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background:
        radial-gradient(ellipse at 88% 18%, rgba(0, 0, 168, 0.16) 0%, transparent 60%),
        radial-gradient(ellipse at 12% 82%, rgba(156, 188, 226, 0.06) 0%, transparent 50%);
      pointer-events: none;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      position: relative;
      z-index: 1;
    }
    .logo-box {
      width: 44px;
      height: 44px;
      background: #ffffff;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.4);
    }
    .logo-box img {
      width: 38px;
      height: 38px;
      object-fit: contain;
    }
    .brand-name {
      font-family: 'Instrument Serif', Georgia, serif;
      font-size: 40px;
      letter-spacing: -0.02em;
      color: #ffffff;
      line-height: 1;
    }
    .brand-tag {
      font-family: 'Geist Mono', monospace;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: #8e8f88;
      margin-left: 20px;
      padding-left: 20px;
      border-left: 1px solid #2e2f2a;
    }

    .divider {
      width: 100%;
      height: 1px;
      background: #2a2b27;
      position: relative;
      z-index: 1;
    }
    .divider.top {
      margin: 28px 0 38px;
    }
    .divider.bottom {
      margin-top: 36px;
    }

    .main {
      position: relative;
      z-index: 1;
      margin-bottom: auto;
    }
    .headline {
      font-family: 'Instrument Serif', Georgia, serif;
      font-size: 82px;
      line-height: 1.04;
      letter-spacing: -0.025em;
      color: #f6f4ed;
      font-weight: 400;
    }
    .headline em {
      font-style: italic;
      color: #9cbce2;
    }

    .bottom {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 32px;
      position: relative;
      z-index: 1;
    }
    .bottom-left {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .roles-line {
      font-family: 'Geist Mono', monospace;
      font-size: 18px;
      font-weight: 600;
      color: #9cbce2;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      flex-direction: column;
      align-items: flex-start;
      max-width: 680px;
      gap: 6px;
    }
    .details-line {
      font-family: 'Geist Mono', monospace;
      font-size: 15px;
      line-height: 1.5;
      color: #8e8f88;
      letter-spacing: 0.01em;
    }

    .cta-badge {
      background: #0000c8;
      color: #ffffff;
      font-family: 'Geist Mono', monospace;
      font-size: 26px;
      font-weight: 500;
      letter-spacing: 0.02em;
      padding: 16px 36px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.5);
      white-space: nowrap;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-box">
      <img src="${logoDataUri}" alt="Shiba logo" />
    </div>
    <div class="brand-name">Shiba</div>
    <div class="brand-tag">AI EMPLOYEES</div>
  </div>

  <div class="divider top"></div>

  <div class="main">
    <h1 class="headline">
      AI employees for<br>
      the work behind<br>
      <em>your company.</em>
    </h1>
  </div>

  <div class="bottom">
    <div class="bottom-left">
      <div class="roles-line">
        <span>Code · Design · Marketing · Sales</span>
        <span>Operations · Finance · Revenue</span>
      </div>
      <div class="details-line">
        Free to self-host. Hosting and model usage cost extra.
      </div>
    </div>
    <div class="cta-badge">tryshiba.dev</div>
  </div>

  <div class="divider bottom"></div>
</body>
</html>`;

async function generate() {
  const executablePath =
    process.env.CHROME_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  console.log('Launching browser to generate OG image...');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });

    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const img = document.querySelector('img');
      if (img && !img.complete) {
        await img.decode();
      }
    });

    await page.screenshot({
      path: outputPath,
      type: 'png',
    });

    console.log(`Generated OG image: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

generate().catch((err) => {
  console.error('Failed to generate OG image:', err);
  process.exit(1);
});
