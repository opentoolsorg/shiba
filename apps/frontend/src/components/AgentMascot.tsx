import type { JSX } from "react";
import type { AgentMascotAcc, AgentMascotEyes, AgentMascotLook, AgentMascotShape } from "@shiba/shared";

const EYE = "#f4fffc";
const VISOR = "#14161c";
const VISOR_HIGHLIGHT = "#2c3548";
const GLYPH_INK = "#332a24";
const GLYPH_INK_ON_DARK = "#f4e2c4";
/** Dark coats sit within a hair of a dark card, so their silhouette carries a light rim. */
const DARK_COAT_RIM = "rgba(244,255,252,0.38)";

function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.max(0, Math.min(255, ((value >> shift) & 255) + amount)).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** Luma in sRGB space; only used to keep the muzzle glyph legible on dark coats. */
function isDark(hex: string): boolean {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.42;
}

function Head({ shape, color, rim }: { shape: AgentMascotShape; color: string; rim?: string }) {
  const edge = rim ? { stroke: rim, strokeWidth: 0.9 } : {};
  switch (shape) {
    case "round":
      return <ellipse cx="32" cy="39" rx="16.5" ry="15" fill={color} {...edge} />;
    case "bean":
      return <path fill={color} {...edge} d="M15 40c0-11 7-17 17-17 7 0 11 3 14 8 3 7 0 16-6 20-8 5-25 3-25-11z" />;
    case "pointed":
      return <path fill={color} {...edge} d="M32 23c9 5 17 11 17 19 0 10-7.5 16.5-17 16.5S15 52 15 42c0-8 8-14 17-19z" />;
    case "cloud":
      return <path fill={color} {...edge} d="M18 44c-5.5.5-8-5-5.5-9 1.2-5.2 7-7.4 11.2-5.2 1.6-5.4 8.4-7.6 13.4-4.2 4.6-2.4 10.4.4 11.2 6.2 4.6.4 7.2 6.2 4.2 10.2-1.6 4.2-6.4 5.2-10.4 4.2-2.2 3.6-8 4.6-12.2 2.4-3.4 2-9.2 1.2-11.9-4.6z" />;
    case "hex":
      return <polygon fill={color} {...edge} points="32,22 49,31 49,47 32,55 15,47 15,31" />;
    case "squircle":
      return <rect x="15" y="24" width="34" height="30" rx="12" fill={color} {...edge} />;
    case "pebble":
      return <path fill={color} {...edge} d="M17 42c-4-12 2-20 15-22 10-1.5 17 4 20 13 2.5 9-2 16.5-12 19.5-9 2.5-25-1.5-23-10.5z" />;
    case "egg":
      return <ellipse cx="32" cy="40" rx="14" ry="17.5" fill={color} {...edge} />;
    case "capsule":
      return <rect x="17" y="26" width="30" height="28" rx="14" fill={color} {...edge} />;
    default:
      return null;
  }
}

function EyeGlyph({ kind, x, side = -1 }: { kind: AgentMascotEyes; x: number; side?: 1 | -1 }) {
  const stroke = { fill: "none", stroke: EYE, strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "pill") return <rect x={x - 2} y="38" width="4" height="2" rx="1" fill={EYE} />;
  if (kind === "big") return <circle cx={x} cy="39" r="2" fill={EYE} />;
  if (kind === "happy") return <path {...stroke} d={`M${x - 2.4} 39.4Q${x} 36.2 ${x + 2.4} 39.4`} />;
  if (kind === "surprised") return <g><circle {...stroke} cx={x} cy="39" r="2" /><circle cx={x} cy="39" r="0.55" fill={EYE} /></g>;
  if (kind === "squint") return <path {...stroke} d={`M${x - 3} 39h6`} />;
  if (kind === "sleepy") return <path {...stroke} d={`M${x - 3} 38.2Q${x} 42 ${x + 3} 38.2`} />;
  if (kind === "heart") return <path fill={EYE} d={`M${x} 40.6c-2.4-1.5-3.3-3.6-1.8-4.7 0.9-0.7 1.8-0.2 1.8 0.7 0-0.9 0.9-1.4 1.8-0.7 1.5 1.1 0.6 3.2-1.8 4.7z`} />;
  if (kind === "star") return <polygon fill={EYE} points={`${x},35.4 ${x + 0.9},37.6 ${x + 3.1},37.8 ${x + 1.4},39.4 ${x + 1.9},41.6 ${x},40.4 ${x - 1.9},41.6 ${x - 1.4},39.4 ${x - 3.1},37.8 ${x - 0.9},37.6`} />;
  if (kind === "code") return <path {...stroke} d={`M${x + side} 37 L${x - side} 39 L${x + side} 41`} />;
  return null;
}

function Eyes({ kind }: { kind: AgentMascotEyes }) {
  if (kind === "wink") {
    return (
      <g className="shiba-mascot-blink">
        <EyeGlyph kind="pill" x={25} />
        <path d="M36.6 39.4H41.4" fill="none" stroke={EYE} strokeWidth="1.5" strokeLinecap="round" />
      </g>
    );
  }
  return (
    <g className="shiba-mascot-blink">
      <EyeGlyph kind={kind} x={25} side={1} />
      <EyeGlyph kind={kind} x={39} side={-1} />
    </g>
  );
}

/** Muzzle glyphs sit under the visor, on the chin. Each shape's chin height differs. */
const MUZZLE_SHIFT: Record<AgentMascotShape, number> = {
  pointed: 0, egg: 0, pebble: 0, round: -3.5, squircle: -3.5, capsule: -3.5, hex: -3.5, bean: -3.5, cloud: -6,
};

function Accessory({ acc, ink, shift }: { acc: AgentMascotAcc; ink: string; shift: number }) {
  if (acc === "none") return null;
  const glyphs: Partial<Record<AgentMascotAcc, string>> = {
    pen: "m29 55 6-5m-4 6 5-5",
    wrench: "m29 56 5-5m0 0 2-1m-2 1 1 2",
    megaphone: "M27 51h3l5-3v8l-5-3h-3z",
    coffee: "M28 51h6v4h-6zm6 0h2v2h-2",
    loupe: "M33 53a2 2 0 1 0-4 0 2 2 0 0 0 4 0zm0 1 2 2",
    bag: "M28 51h8v5h-8z",
    check: "m28 53 3 3 5-6",
    list: "M28 51h8m-6 2h6m-8 2h8",
    clipboard: "M28 51h8v6h-8zM30 50h4v2h-4z",
    compass: "M33 54a1.8 1.8 0 1 0-3.6 0 1.8 1.8 0 0 0 3.6 0zm-3 -1.2 2.4 0.9-2.4 0.9z",
    headset: "M28 53a4 3.2 0 0 1 8 0M28 53v3M36 53v3M28 56h1.6M34.4 56H36",
    chart: "M27 57v-5M27 57h10M29 57v-3M32 57v-5M35 57v-2",
  };
  return (
    <g data-part="accessory" transform={shift ? `translate(0 ${shift})` : undefined}>
      <path d={glyphs[acc]} fill="none" stroke={ink} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/**
 * Original pointed-ear Shiba with a dark visor face. No third-party mascot art.
 * Geometry matches the public marketing mark and its role variants: same ears,
 * head curve, fluff, visor and eye strokes at 64 units.
 */
export function AgentMascot({ look, expression, live = false, label }: {
  look: AgentMascotLook;
  expression?: AgentMascotEyes;
  live?: boolean;
  label?: string;
}): JSX.Element {
  const eyes = expression ?? look.eyes;
  const inner = shade(look.color, -48);
  const rim = isDark(look.color) ? DARK_COAT_RIM : undefined;
  return (
    <svg
      viewBox="0 0 64 64"
      className="shiba-agent-mascot size-full overflow-visible"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-shape={look.shape}
      data-color={look.color}
      data-eyes={look.eyes}
      data-expression={eyes}
      data-acc={look.acc}
      data-live={live ? "true" : "false"}
    >
      <g data-part="ears">
        <path d="M17 31 L23.5 6 L33 28 Z" fill={look.color} stroke={rim} strokeWidth={rim ? 0.9 : undefined} />
        <path d="M47 31 L40.5 6 L31 28 Z" fill={look.color} stroke={rim} strokeWidth={rim ? 0.9 : undefined} />
      </g>
      <Head shape={look.shape} color={look.color} rim={rim} />
      <g data-part="fluff" fill={look.color}>
        <circle cx="22" cy="30" r="3.1" />
        <circle cx="32" cy="26" r="3.5" />
        <circle cx="42" cy="30" r="3.1" />
        <circle cx="17.5" cy="42" r="2.5" />
        <circle cx="46.5" cy="42" r="2.5" />
      </g>
      <g data-part="inner-ear" fill={inner}>
        <path d="M21.2 27 L24 12 L29.2 25.5 Z" />
        <path d="M42.8 27 L40 12 L34.8 25.5 Z" />
      </g>
      <g data-part="visor">
        <rect x="18" y="31" width="28" height="15" rx="6" fill={VISOR} />
        <rect x="20" y="32.4" width="24" height="3.2" rx="1.6" fill={VISOR_HIGHLIGHT} />
      </g>
      <g className="shiba-mascot-gaze" data-part="eyes">
        <Eyes kind={eyes} />
      </g>
      <Accessory acc={look.acc} ink={isDark(look.color) ? GLYPH_INK_ON_DARK : GLYPH_INK} shift={MUZZLE_SHIFT[look.shape]} />
    </svg>
  );
}
