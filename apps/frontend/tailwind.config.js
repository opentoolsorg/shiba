import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  future: {
    // Prevent persistent :hover styles after taps on touchscreens.
    hoverOnlyWhenSupported: true,
  },
  // Class strategy so  variants follow the in-app next-themes toggle
  // (html.dark), not the OS prefers-color-scheme.
  darkMode: "class",
  content: [
    resolve(root, "src/**/*.{js,ts,jsx,tsx,html}"),
    resolve(root, "../web/src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"),
  ],
  theme: {
    extend: {
      screens: {
        touch: { raw: "(pointer: coarse)" },
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
        tech: ['"Geist Mono"', 'monospace'],
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        DEFAULT: 'var(--radius)',
        inner: 'var(--radius-inner)',
        button: 'var(--radius-button)',
        kbd: 'var(--radius-kbd)',
        card: 'var(--radius-card)',
        overlay: 'var(--radius-overlay)',
        panel: 'var(--radius-panel)',
      },
      boxShadow: {
        plate: 'var(--sh-plate)',
        card: 'var(--sh-card)',
        overlay: 'var(--sh-overlay)',
        composer: 'var(--sh-composer)',
        sheet: 'var(--sh-sheet)',
      },
      colors: {
        bg: 'var(--bg)',
        chrome: 'var(--chrome)',
        panel: 'var(--panel)',
        card: {
          DEFAULT: 'var(--card)',
          hover: 'var(--card-hover)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          hover: 'var(--popover-hover)',
        },
        input: 'var(--input)',
        button: {
          DEFAULT: 'var(--button)',
          hover: 'var(--button-hover)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          hover: 'var(--secondary-hover)',
        },
        section: 'var(--section)',
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground-1)',
          'foreground-1': 'var(--muted-foreground-1)',
          'foreground-2': 'var(--muted-foreground-2)',
          'foreground-3': 'var(--muted-foreground-3)',
        },
        overlay: {
          DEFAULT: 'var(--overlay)',
          fg: 'var(--overlay-fg)',
          media: 'var(--overlay-media)',
        },
        fg: 'var(--fg)',
        border: {
          DEFAULT: 'var(--border-1)',
          1: 'var(--border-1)',
          2: 'var(--border-2)',
          3: 'var(--border-3)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          soft: 'var(--primary-soft)',
          'soft-hover': 'var(--primary-soft-hover)',
          foreground: 'var(--primary-text)',
        },
        ring: 'var(--ring)',
        destructive: {
          DEFAULT: 'var(--destructive)',
          soft: 'var(--destructive-soft)',
          'soft-hover': 'var(--destructive-soft-hover)',
          foreground: 'var(--destructive-text)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          fg: 'var(--warning-fg)',
          subtle: 'var(--warning-subtle)',
        },
        success: 'var(--success)',
        info: 'var(--info)',
        complete: 'var(--complete)',
        attention: 'var(--attention)',
        progress: 'var(--progress)',
        brand: {
          DEFAULT: 'var(--primary)',
          light: 'var(--primary-soft)',
          dark: 'var(--shader-ink)',
          glow: 'color-mix(in oklch, var(--primary) 24%, transparent)',
        },
      },
    },
  },
  plugins: [],
}
