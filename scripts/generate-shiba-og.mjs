import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function toBase64(filePath) {
  const fileData = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1);
  return `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${fileData.toString('base64')}`;
}

const mascotDir = path.join(rootDir, 'apps/web/public/assets/mascot');
const petLogoBase64 = toBase64(path.join(mascotDir, 'pet-logo.png'));
const heroStickerBase64 = toBase64(path.join(mascotDir, 'shiba-sticker-hero.webp'));
const climbingStickerBase64 = toBase64(path.join(mascotDir, 'shiba-sticker-climbing.webp'));
const ridingStickerBase64 = toBase64(path.join(mascotDir, 'shiba-sticker-riding.webp'));
const sunglassesStickerBase64 = toBase64(path.join(mascotDir, 'shiba-sticker-sunglasses.webp'));

// Icons
const checkIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#95c4a0" stroke-width="3" stroke-linecap="square"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const chartIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#95c4a0" stroke-width="2.5"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600;700&family=Instrument+Serif:ital,wght@0,400;1,400&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      border-radius: 0 !important; /* Hard rule from DESIGN.md: border-radius 0 everywhere */
    }

    body {
      width: 2400px;
      height: 1260px;
      overflow: hidden;
      background-color: #191a18; /* Canonical dark paper from DESIGN.md */
      color: #eae8e1; /* Canonical ink */
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 60px 80px 48px 80px;
    }

    /* Retro Paper-OS Dot Grid */
    .bg-dot-grid {
      position: absolute;
      inset: 0;
      background-image: radial-gradient(rgba(234, 232, 225, 0.09) 1.2px, transparent 1.2px);
      background-size: 20px 20px;
      pointer-events: none;
      z-index: 1;
    }

    /* Subtle ambient dark blue/cobalt well */
    .ambient-accent {
      position: absolute;
      top: 14%;
      left: 30%;
      width: 1000px;
      height: 600px;
      background: radial-gradient(ellipse at center, rgba(30, 40, 180, 0.12) 0%, transparent 70%);
      pointer-events: none;
      z-index: 1;
    }

    .canvas {
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      height: 100%;
      justify-content: space-between;
    }

    /* Top Bar */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
      border-bottom: 1.5px solid #3b3d36;
      padding-bottom: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .brand-logo-frame {
      width: 64px;
      height: 64px;
      background: #222320;
      border: 1.5px solid #3b3d36;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 3px 3px 0 #000000;
    }
    .brand-logo-frame img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: -webkit-optimize-contrast;
    }
    .brand-text {
      display: flex;
      align-items: baseline;
      gap: 14px;
    }
    .brand-title {
      font-size: 40px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #eae8e1;
      font-family: 'Geist', sans-serif;
    }
    .brand-chip {
      font-family: 'Geist Mono', monospace;
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #aaa99f;
      background: #272824;
      border: 1px solid #3b3d36;
      padding: 4px 10px;
    }
    .top-right {
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .os-badge {
      font-family: 'Geist Mono', monospace;
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #9cbce2; /* Navy light token */
      background: rgba(0, 0, 168, 0.25);
      border: 1.5px solid #0000a8;
      padding: 6px 14px;
      box-shadow: 2px 2px 0 #000000;
    }
    .domain {
      font-family: 'Geist Mono', monospace;
      font-size: 28px;
      font-weight: 600;
      color: #aaa99f;
      letter-spacing: -0.2px;
    }

    /* Hero Headline */
    .hero-strip {
      margin-top: 24px;
      margin-bottom: 24px;
    }
    .hero-h1 {
      font-family: 'Instrument Serif', Georgia, serif;
      font-size: 96px;
      font-weight: 400;
      line-height: 1.02;
      letter-spacing: -0.02em;
      color: #ffffff;
    }
    .hero-h1 .serif-italic {
      font-style: italic;
      color: #f6f4ed;
    }
    .hero-h1 .accent-word {
      color: #f99c00; /* Warm paper-OS amber */
      font-style: italic;
    }
    .hero-subhead {
      font-family: 'Geist Mono', monospace;
      font-size: 21px;
      font-weight: 500;
      color: #aaa99f;
      margin-top: 14px;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .hero-subhead span.bullet {
      color: #55574f;
    }

    /* 5 Columns - Retro Windows */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 24px;
      width: 100%;
      margin-bottom: 28px;
    }

    .bot-window {
      background: #222320; /* Raised card surface */
      border: 1.5px solid #3b3d36;
      box-shadow: 4px 4px 0 #000000;
      display: flex;
      flex-direction: column;
      height: 500px;
      position: relative;
    }

    /* Window Titlebar */
    .window-titlebar {
      background: #272824;
      border-bottom: 1.5px solid #3b3d36;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
    }
    .titlebar-left {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: 'Geist Mono', monospace;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #eae8e1;
    }
    .titlebar-left .num {
      color: #f99c00;
    }
    .window-marks {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .mark-btn {
      width: 14px;
      height: 14px;
      background: #3b3d36;
      border: 1px solid #55574f;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Mascot Header inside window */
    .bot-profile {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 18px 14px 18px;
      border-bottom: 1px solid #2d2f2a;
    }
    .mascot-frame {
      width: 66px;
      height: 66px;
      background: #191a18;
      border: 1.5px solid #3b3d36;
      box-shadow: 2px 2px 0 #000000;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .mascot-frame img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .bot-name-col {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .bot-name {
      font-family: 'Instrument Serif', Georgia, serif;
      font-size: 28px;
      font-weight: 400;
      letter-spacing: -0.2px;
      color: #ffffff;
      line-height: 1.1;
    }
    .bot-role-tag {
      font-family: 'Geist Mono', monospace;
      font-size: 11.5px;
      font-weight: 700;
      color: #f99c00; /* Warm amber */
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    /* Window Body */
    .window-body {
      flex: 1;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .content-stack {
      display: flex;
      flex-direction: column;
      gap: 13px;
    }

    .metric-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #2d2f2a;
      padding-bottom: 9px;
      font-size: 15.5px;
    }
    .metric-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .metric-key {
      font-family: 'Geist', sans-serif;
      font-weight: 500;
      color: #aaa99f;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .metric-val {
      font-family: 'Geist Mono', monospace;
      font-size: 14px;
      font-weight: 600;
      color: #eae8e1;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .metric-val.ok {
      color: #95c4a0;
    }

    /* Terminal diff box */
    .terminal-box {
      background: #141412;
      border: 1px solid #3b3d36;
      padding: 14px;
      font-family: 'Geist Mono', monospace;
      font-size: 13.5px;
      line-height: 1.55;
      color: #eae8e1;
      box-shadow: 2px 2px 0 #000000;
    }
    .terminal-box .green { color: #95c4a0; }
    .terminal-box .blue { color: #9cbce2; }
    .terminal-box .muted { color: #6a6f63; }

    /* Task file chip */
    .file-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: 'Geist Mono', monospace;
      font-size: 12.5px;
      color: #aaa99f;
      background: #1a1b18;
      border: 1px solid #2d2f2a;
      padding: 6px 10px;
    }

    /* Social draft box */
    .draft-box {
      background: #141412;
      border: 1px solid #3b3d36;
      padding: 14px;
      font-family: 'Geist', sans-serif;
      font-size: 15px;
      line-height: 1.48;
      color: #eae8e1;
      box-shadow: 2px 2px 0 #000000;
    }
    .draft-label {
      font-family: 'Geist Mono', monospace;
      font-size: 11.5px;
      color: #f99c00;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 6px;
      font-weight: 600;
    }

    /* Pixel Chart */
    .chart-panel {
      background: #141412;
      border: 1px solid #3b3d36;
      padding: 14px;
      box-shadow: 2px 2px 0 #000000;
    }
    .chart-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: 'Geist Mono', monospace;
      font-size: 13.5px;
      color: #aaa99f;
      margin-bottom: 10px;
    }
    .chart-head .growth {
      color: #95c4a0;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .retro-bars {
      display: flex;
      align-items: flex-end;
      gap: 9px;
      height: 80px;
      padding: 4px 0;
    }
    .retro-bar {
      flex: 1;
      background: #3b3d36;
      border-top: 2px solid #55574f;
    }
    .retro-bar.active {
      background: #0000a8;
      border-top: 2px solid #9cbce2;
      box-shadow: 2px 2px 0 #000000;
    }

    /* Bottom Status Gate Chip */
    .window-footer-chip {
      background: #191a18;
      border: 1px solid #3b3d36;
      padding: 9px 12px;
      font-family: 'Geist Mono', monospace;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #eae8e1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 2px 2px 0 #000000;
    }
    .window-footer-chip.approval {
      border-color: #0000a8;
      color: #9cbce2;
      background: rgba(0, 0, 168, 0.2);
    }
    .window-footer-chip.ok {
      border-color: #227146;
      color: #95c4a0;
      background: rgba(34, 113, 70, 0.2);
    }

    /* Footer Statusbar */
    .statusbar {
      border-top: 1.5px solid #3b3d36;
      padding-top: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }
    .statusbar-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .sb-label {
      font-family: 'Geist Mono', monospace;
      font-size: 12.5px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #6a6f63;
      margin-right: 6px;
    }
    .sb-cell {
      font-family: 'Geist Mono', monospace;
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #aaa99f;
      background: #222320;
      border: 1px solid #3b3d36;
      padding: 7px 14px;
      box-shadow: 2px 2px 0 #000000;
    }
    .sb-cell.highlight {
      color: #eae8e1;
      border-color: #55574f;
    }

    .statusbar-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .channel-cell {
      font-family: 'Geist Mono', monospace;
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #aaa99f;
      background: #222320;
      border: 1px solid #3b3d36;
      padding: 7px 14px;
      box-shadow: 2px 2px 0 #000000;
    }
  </style>
</head>
<body>
  <div class="bg-dot-grid"></div>
  <div class="ambient-accent"></div>

  <div class="canvas">
    <!-- Top Bar -->
    <header class="top-bar">
      <div class="brand">
        <div class="brand-logo-frame">
          <img src="${petLogoBase64}" alt="Shiba Mascot">
        </div>
        <div class="brand-text">
          <div class="brand-title">Shiba</div>
          <div class="brand-chip">Open Source · Self-Hosted</div>
        </div>
      </div>
      <div class="top-right">
        <div class="os-badge">Cloudflare Workers + Sandbox</div>
        <div class="domain">tryshiba.dev</div>
      </div>
    </header>

    <!-- Hero Title -->
    <div class="hero-strip">
      <h1 class="hero-h1">
        AI employees that ship <span class="accent-word">while you sleep.</span>
      </h1>
      <p class="hero-subhead">
        <span>CODING</span> <span class="bullet">·</span>
        <span>TESTING</span> <span class="bullet">·</span>
        <span>OPERATIONS</span> <span class="bullet">·</span>
        <span>MARKETING</span> <span class="bullet">·</span>
        <span>SALES</span> <span class="bullet">·</span>
        <span>ONE APPROVAL GATE BEFORE COMMIT</span>
      </p>
    </div>

    <!-- 5 Retro-OS Bot Windows -->
    <div class="cards-grid">
      <!-- 01 / CODING -->
      <div class="bot-window">
        <div class="window-titlebar">
          <div class="titlebar-left"><span class="num">01</span> / Dev · Coding</div>
          <div class="window-marks"><div class="mark-btn"></div><div class="mark-btn"></div><div class="mark-btn"></div></div>
        </div>
        <div class="bot-profile">
          <div class="mascot-frame">
            <img src="${heroStickerBase64}" alt="Shiba Coding">
          </div>
          <div class="bot-name-col">
            <div class="bot-name">Coding Bot</div>
            <div class="bot-role-tag">Software Engineer</div>
          </div>
        </div>
        <div class="window-body">
          <div class="content-stack">
            <div class="file-chip">📁 task/checkout-fix</div>
            <div class="terminal-box">
              <span class="blue">import</span> { Sandbox } <span class="blue">from</span> <span class="muted">'@cf/sandbox'</span><br>
              <span class="green">+ const</span> session = <span class="blue">await</span> verify()<br>
              <span class="muted">+ 3 files changed (+142 -8)</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">Harness</span>
              <span class="metric-val ok">Claude Code ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">OpenCode</span>
              <span class="metric-val ok">clean diff ${checkIcon}</span>
            </div>
          </div>
          <div class="window-footer-chip approval">
            <span>Approval Gate</span>
            <span>READY TO REVIEW</span>
          </div>
        </div>
      </div>

      <!-- 02 / TESTING -->
      <div class="bot-window">
        <div class="window-titlebar">
          <div class="titlebar-left"><span class="num">02</span> / QA · Testing</div>
          <div class="window-marks"><div class="mark-btn"></div><div class="mark-btn"></div><div class="mark-btn"></div></div>
        </div>
        <div class="bot-profile">
          <div class="mascot-frame">
            <img src="${climbingStickerBase64}" alt="Shiba Testing">
          </div>
          <div class="bot-name-col">
            <div class="bot-name">Testing Bot</div>
            <div class="bot-role-tag">QA &amp; Verification</div>
          </div>
        </div>
        <div class="window-body">
          <div class="content-stack">
            <div class="file-chip">📁 task/auth-qa-run</div>
            <div class="metric-row">
              <span class="metric-key">Vitest Suite</span>
              <span class="metric-val ok">48 passed ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">TypeScript</span>
              <span class="metric-val ok">0 errors ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">Security AST</span>
              <span class="metric-val ok">0 leaks ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">Playwright E2E</span>
              <span class="metric-val ok">12/12 pass ${checkIcon}</span>
            </div>
          </div>
          <div class="window-footer-chip ok">
            <span>Sandbox Check</span>
            <span>100% GREEN</span>
          </div>
        </div>
      </div>

      <!-- 03 / OPERATIONS -->
      <div class="bot-window">
        <div class="window-titlebar">
          <div class="titlebar-left"><span class="num">03</span> / Ops · Infra</div>
          <div class="window-marks"><div class="mark-btn"></div><div class="mark-btn"></div><div class="mark-btn"></div></div>
        </div>
        <div class="bot-profile">
          <div class="mascot-frame">
            <img src="${ridingStickerBase64}" alt="Shiba Ops">
          </div>
          <div class="bot-name-col">
            <div class="bot-name">Operations Bot</div>
            <div class="bot-role-tag">Cloud &amp; DevOps</div>
          </div>
        </div>
        <div class="window-body">
          <div class="content-stack">
            <div class="file-chip">📁 task/workers-sync</div>
            <div class="metric-row">
              <span class="metric-key">CF Worker</span>
              <span class="metric-val ok">live ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">D1 Database</span>
              <span class="metric-val ok">synced ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">AI Gateway</span>
              <span class="metric-val ok">0ms egress ${checkIcon}</span>
            </div>
            <div class="metric-row">
              <span class="metric-key">Docker Daemon</span>
              <span class="metric-val ok">healthy ${checkIcon}</span>
            </div>
          </div>
          <div class="window-footer-chip ok">
            <span>Your Account</span>
            <span>AUTONOMOUS OPS</span>
          </div>
        </div>
      </div>

      <!-- 04 / MARKETING -->
      <div class="bot-window">
        <div class="window-titlebar">
          <div class="titlebar-left"><span class="num">04</span> / Growth · Content</div>
          <div class="window-marks"><div class="mark-btn"></div><div class="mark-btn"></div><div class="mark-btn"></div></div>
        </div>
        <div class="bot-profile">
          <div class="mascot-frame">
            <img src="${petLogoBase64}" alt="Shiba Marketing">
          </div>
          <div class="bot-name-col">
            <div class="bot-name">Marketing Bot</div>
            <div class="bot-role-tag">Growth &amp; SEO</div>
          </div>
        </div>
        <div class="window-body">
          <div class="content-stack">
            <div class="file-chip">📁 marketing/brief.md</div>
            <div class="draft-box">
              <div class="draft-label">𝕏 Draft · in repo</div>
              "AI employees for the work behind your company. Runs in your Cloudflare account. It asks before writing code 🐕"
            </div>
            <div class="metric-row">
              <span class="metric-key">SEO &amp; GEO Rank</span>
              <span class="metric-val ok">#1 cited ${checkIcon}</span>
            </div>
          </div>
          <div class="window-footer-chip approval">
            <span>Decision Queue</span>
            <span>WAITS FOR YOU</span>
          </div>
        </div>
      </div>

      <!-- 05 / SALES -->
      <div class="bot-window">
        <div class="window-titlebar">
          <div class="titlebar-left"><span class="num">05</span> / Revenue · Sales</div>
          <div class="window-marks"><div class="mark-btn"></div><div class="mark-btn"></div><div class="mark-btn"></div></div>
        </div>
        <div class="bot-profile">
          <div class="mascot-frame">
            <img src="${sunglassesStickerBase64}" alt="Shiba Sales">
          </div>
          <div class="bot-name-col">
            <div class="bot-name">Sales Bot</div>
            <div class="bot-role-tag">Revenue &amp; CRM</div>
          </div>
        </div>
        <div class="window-body">
          <div class="content-stack">
            <div class="file-chip">📁 sales/pipeline.md</div>
            <div class="chart-panel">
              <div class="chart-head">
                <span>Pipeline · 7d</span>
                <span class="growth">${chartIcon} ▲ 42%</span>
              </div>
              <div class="retro-bars">
                <div class="retro-bar" style="height: 35%;"></div>
                <div class="retro-bar" style="height: 55%;"></div>
                <div class="retro-bar" style="height: 45%;"></div>
                <div class="retro-bar" style="height: 70%;"></div>
                <div class="retro-bar active" style="height: 100%;"></div>
              </div>
            </div>
            <div class="metric-row">
              <span class="metric-key">Inbound Leads</span>
              <span class="metric-val ok">+38 qualified ${checkIcon}</span>
            </div>
          </div>
          <div class="window-footer-chip ok">
            <span>CRM Sync</span>
            <span>PIPELINE ACTIVE</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Retro Statusbar Footer -->
    <footer class="statusbar">
      <div class="statusbar-left">
        <span class="sb-label">Architecture</span>
        <div class="sb-cell highlight">Cloudflare Workers</div>
        <div class="sb-cell highlight">Sandbox SDK</div>
        <div class="sb-cell highlight">Agents SDK</div>
        <div class="sb-cell">OpenCode</div>
        <div class="sb-cell">Claude Code</div>
        <div class="sb-cell">Codex</div>
      </div>
      <div class="statusbar-right">
        <span class="sb-label">Channels</span>
        <div class="channel-cell">GitHub</div>
        <div class="channel-cell">Slack</div>
        <div class="channel-cell">Linear</div>
        <div class="channel-cell">Discord</div>
      </div>
    </footer>
  </div>
</body>
</html>`;

const htmlPath = path.join(rootDir, 'apps/web/public/assets/og/temp-og.html');
fs.writeFileSync(htmlPath, html);

const outputPath = path.join(rootDir, 'apps/web/public/assets/og/shiba-og.png');

console.log('Rendering 2400x1260 OG image with Google Chrome...');
execSync(
  `'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --disable-gpu --window-size=2400,1260 --screenshot='${outputPath}' 'file://${htmlPath}'`,
  { stdio: 'inherit' }
);

try { fs.unlinkSync(htmlPath); } catch {}

const targetPaths = [
  path.join(rootDir, 'apps/frontend/dist/client/assets/og/shiba-og.png'),
  path.join(rootDir, 'public/assets/og/shiba-og.png'),
  path.join(rootDir, 'app-public/assets/og/shiba-og.png')
];

for (const target of targetPaths) {
  if (fs.existsSync(path.dirname(target))) {
    fs.copyFileSync(outputPath, target);
    console.log(`Copied to ${target}`);
  }
}

console.log('Generated successfully at ' + outputPath);
