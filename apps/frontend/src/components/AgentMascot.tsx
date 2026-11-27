import type { JSX } from "react";
import type { AgentMascotAcc, AgentMascotEyes, AgentMascotLook, AgentMascotShape } from "@shiba/shared";

const LED = "#f4fffc";
const SCREEN = "#111318";
const SCREEN_HIGHLIGHT = "#2a303b";
const GLYPH_INK = "#d4d4d8";
const DARK_SHELL_RIM = "rgba(244,255,252,0.38)";

function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.max(0, Math.min(255, ((value >> shift) & 255) + amount)).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function isDark(hex: string): boolean {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.42;
}

function Shell({ shape, color, rim }: { shape: AgentMascotShape; color: string; rim?: string }) {
  const edge = rim ? { stroke: rim, strokeWidth: 0.9 } : {};
  switch (shape) {
    case "round":
      return <circle cx="32" cy="38" r="18" fill={color} {...edge} />;
    case "bean":
      return <rect x="15" y="23" width="34" height="31" rx="15" fill={color} transform="rotate(-7 32 38)" {...edge} />;
    case "pointed":
      return <polygon fill={color} {...edge} points="32,19 50,29 50,46 32,57 14,46 14,29" />;
    case "cloud":
      return <rect x="13" y="25" width="38" height="27" rx="13" fill={color} {...edge} />;
    case "hex":
      return <polygon fill={color} {...edge} points="32,20 49,29 49,47 32,56 15,47 15,29" />;
    case "squircle":
      return <rect x="14" y="21" width="36" height="34" rx="12" fill={color} {...edge} />;
    case "pebble":
      return <rect x="14" y="23" width="36" height="31" rx="12" fill={color} transform="rotate(5 32 38)" {...edge} />;
    case "egg":
      return <ellipse cx="32" cy="38" rx="16" ry="19" fill={color} {...edge} />;
    case "capsule":
      return <rect x="14" y="22" width="36" height="33" rx="16" fill={color} {...edge} />;
    default:
      return null;
  }
}

function EyeGlyph({ kind, x, side = -1 }: { kind: AgentMascotEyes; x: number; side?: 1 | -1 }) {
  const stroke = { fill: "none", stroke: LED, strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "pill") return <rect x={x - 2} y="38" width="4" height="2" rx="1" fill={LED} />;
  if (kind === "big") return <circle cx={x} cy="39" r="2" fill={LED} />;
  if (kind === "happy") return <path {...stroke} d={`M${x - 2.4} 39.4Q${x} 36.2 ${x + 2.4} 39.4`} />;
  if (kind === "surprised") return <g><circle {...stroke} cx={x} cy="39" r="2" /><circle cx={x} cy="39" r="0.55" fill={LED} /></g>;
  if (kind === "squint") return <path {...stroke} d={`M${x - 3} 39h6`} />;
  if (kind === "sleepy") return <path {...stroke} d={`M${x - 3} 38.2Q${x} 42 ${x + 3} 38.2`} />;
  if (kind === "heart") return <path fill={LED} d={`M${x} 40.6c-2.4-1.5-3.3-3.6-1.8-4.7 0.9-0.7 1.8-0.2 1.8 0.7 0-0.9 0.9-1.4 1.8-0.7 1.5 1.1 0.6 3.2-1.8 4.7z`} />;
  if (kind === "star") return <polygon fill={LED} points={`${x},35.4 ${x + 0.9},37.6 ${x + 3.1},37.8 ${x + 1.4},39.4 ${x + 1.9},41.6 ${x},40.4 ${x - 1.9},41.6 ${x - 1.4},39.4 ${x - 3.1},37.8 ${x - 0.9},37.6`} />;
  if (kind === "code") return <path {...stroke} d={`M${x + side} 37 L${x - side} 39 L${x + side} 41`} />;
  return null;
}

function Eyes({ kind }: { kind: AgentMascotEyes }) {
  if (kind === "wink") {
    return (
      <g className="shiba-mascot-blink">
        <EyeGlyph kind="pill" x={25} />
        <path d="M36.6 39.4H41.4" fill="none" stroke={LED} strokeWidth="1.5" strokeLinecap="round" />
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

function Accessory({ acc }: { acc: AgentMascotAcc }) {
  if (acc === "none") return null;
  const glyphs: Partial<Record<AgentMascotAcc, string>> = {
    pen: "m29 54 6-5m-4 6 5-5",
    wrench: "m29 55 5-5m0 0 2-1m-2 1 1 2",
    megaphone: "M27 50h3l5-3v8l-5-3h-3z",
    coffee: "M28 50h6v4h-6zm6 0h2v2h-2",
    loupe: "M33 52a2 2 0 1 0-4 0 2 2 0 0 0 4 0zm0 1 2 2",
    bag: "M28 50h8v5h-8z",
    check: "m28 52 3 3 5-6",
    list: "M28 50h8m-6 2h6m-8 2h8",
    clipboard: "M28 50h8v6h-8zM30 49h4v2h-4z",
    compass: "M33 53a1.8 1.8 0 1 0-3.6 0 1.8 1.8 0 0 0 3.6 0zm-3 -1.2 2.4 0.9-2.4 0.9z",
    headset: "M28 52a4 3.2 0 0 1 8 0M28 52v3M36 52v3M28 55h1.6M34.4 55H36",
    chart: "M27 56v-5M27 56h10M29 56v-3M32 56v-5M35 56v-2",
  };
  return (
    <g data-part="accessory">
      <path d={glyphs[acc]} fill="none" stroke={GLYPH_INK} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/**
 * Parameterised robot employee avatar. The persisted look contract is unchanged
 * (shape, shell color, eyes, accessory); the renderer intentionally has no
 * animal ears, fur, or mascot body parts.
 */
export function AgentMascot({ look, expression, live = false, label }: {
  look: AgentMascotLook;
  expression?: AgentMascotEyes;
  live?: boolean;
  label?: string;
}): JSX.Element {
  const eyes = expression ?? look.eyes;
  const trim = shade(look.color, 34);
  const rim = isDark(look.color) ? DARK_SHELL_RIM : undefined;
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
      data-renderer="robot"
    >
      <g data-part="antenna">
        <path d="M32 20V11" fill="none" stroke={trim} strokeWidth="2" strokeLinecap="round" />
        <circle cx="32" cy="8.5" r="3" fill={trim} stroke={rim} strokeWidth={rim ? 0.8 : undefined} />
        <circle cx="32" cy="8.5" r="1" fill={LED} opacity="0.72" />
      </g>
      <g data-part="ports" fill={trim} stroke={rim} strokeWidth={rim ? 0.8 : undefined}>
        <rect x="9" y="34" width="6" height="10" rx="2" />
        <rect x="49" y="34" width="6" height="10" rx="2" />
      </g>
      <Shell shape={look.shape} color={look.color} rim={rim} />
      <path d="M22 25h20" fill="none" stroke={trim} strokeWidth="1" opacity="0.42" strokeLinecap="round" />
      <g data-part="visor">
        <rect x="18" y="31" width="28" height="15" rx="6" fill={SCREEN} />
        <rect x="20" y="32.4" width="24" height="3.2" rx="1.6" fill={SCREEN_HIGHLIGHT} />
      </g>
      <g className="shiba-mascot-gaze" data-part="eyes">
        <Eyes kind={eyes} />
      </g>
      <Accessory acc={look.acc} />
    </svg>
  );
}
