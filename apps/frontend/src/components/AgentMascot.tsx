import type { JSX } from "react";
import type { AgentMascotAcc, AgentMascotEyes, AgentMascotLook, AgentMascotShape } from "@shiba/shared";

function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.max(0, Math.min(255, ((value >> shift) & 255) + amount)).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function Head({ shape, color }: { shape: AgentMascotShape; color: string }) {
  switch (shape) {
    case "round":
      return <ellipse cx="32" cy="39" rx="16.5" ry="15" fill={color} />;
    case "bean":
      return <path fill={color} d="M15 40c0-11 7-17 17-17 7 0 11 3 14 8 3 7 0 16-6 20-8 5-25 3-25-11z" />;
    case "pointed":
      return <path fill={color} d="M32 23c9 5 17 11 17 19 0 10-7.5 16.5-17 16.5S15 52 15 42c0-8 8-14 17-19z" />;
    case "cloud":
      return <path fill={color} d="M18 44c-5.5.5-8-5-5.5-9 1.2-5.2 7-7.4 11.2-5.2 1.6-5.4 8.4-7.6 13.4-4.2 4.6-2.4 10.4.4 11.2 6.2 4.6.4 7.2 6.2 4.2 10.2-1.6 4.2-6.4 5.2-10.4 4.2-2.2 3.6-8 4.6-12.2 2.4-3.4 2-9.2 1.2-11.9-4.6z" />;
    case "hex":
      return <polygon fill={color} points="32,22 49,31 49,47 32,55 15,47 15,31" />;
    case "squircle":
      return <rect x="15" y="24" width="34" height="30" rx="12" fill={color} />;
    case "pebble":
      return <path fill={color} d="M17 42c-4-12 2-20 15-22 10-1.5 17 4 20 13 2.5 9-2 16.5-12 19.5-9 2.5-25-1.5-23-10.5z" />;
    case "egg":
      return <ellipse cx="32" cy="40" rx="14" ry="17.5" fill={color} />;
    case "capsule":
      return <rect x="17" y="26" width="30" height="28" rx="14" fill={color} />;
    default:
      return null;
  }
}

function EyeGlyph({ kind, x }: { kind: AgentMascotEyes; x: number }) {
  const glow = "#8dffd8";
  const core = "#f4fffc";
  if (kind === "big") return <g><circle cx={x} cy="38.5" r="3.4" fill={glow} opacity="0.45" /><circle cx={x} cy="38.5" r="2.15" fill={core} /></g>;
  if (kind === "happy") return <path d={`M${x - 2.4} 39.4 Q${x} 36.2 ${x + 2.4} 39.4`} fill="none" stroke={core} strokeWidth="1.5" strokeLinecap="round" />;
  if (kind === "surprised") return <g><circle cx={x} cy="38.4" r="2.7" fill={glow} opacity="0.4" /><circle cx={x} cy="38.4" r="1.7" fill="none" stroke={core} strokeWidth="1.15" /><circle cx={x} cy="38.6" r="0.55" fill={core} /></g>;
  if (kind === "squint") return <rect x={x - 2.5} y="37.7" width="5" height="1.35" rx="0.7" fill={core} />;
  if (kind === "sleepy") return <path d={`M${x - 2.5} 37.6 Q${x} 40.2 ${x + 2.5} 37.6`} fill="none" stroke={core} strokeWidth="1.45" strokeLinecap="round" />;
  if (kind === "heart") return <path fill={core} d={`M${x} 40.3c-2.2-1.5-3.1-3.3-1.7-4.4 0.8-0.6 1.7-0.2 1.7 0.6 0-0.8 0.9-1.2 1.7-0.6 1.4 1.1 0.5 2.9-1.7 4.4z`} />;
  if (kind === "star") return <polygon fill={core} points={`${x},35.6 ${x + 0.8},37.4 ${x + 2.6},37.6 ${x + 1.3},38.9 ${x + 1.7},40.7 ${x},39.7 ${x - 1.7},40.7 ${x - 1.3},38.9 ${x - 2.6},37.6 ${x - 0.8},37.4`} />;
  if (kind === "code") return <path d={`M${x - 0.3} 36.4 L${x - 2.2} 38.5 L${x - 0.3} 40.6 M${x + 0.5} 36.4 L${x + 2.4} 38.5 L${x + 0.5} 40.6`} fill="none" stroke={core} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />;
  return <g><rect x={x - 2.3} y="36.9" width="4.6" height="3.1" rx="1.5" fill={glow} opacity="0.4" /><rect x={x - 1.55} y="37.5" width="3.1" height="1.9" rx="0.95" fill={core} /></g>;
}

function Eyes({ kind }: { kind: AgentMascotEyes }) {
  if (kind === "wink") {
    return (
      <g className="shiba-mascot-blink">
        <EyeGlyph kind="pill" x={25} />
        <path d="M36.4 38.6 H41.2" fill="none" stroke="#f4fffc" strokeWidth="1.45" strokeLinecap="round" />
      </g>
    );
  }
  return (
    <g className="shiba-mascot-blink">
      <EyeGlyph kind={kind} x={25} />
      <EyeGlyph kind={kind} x={39} />
    </g>
  );
}

function Accessory({ acc, ink }: { acc: AgentMascotAcc; ink: string }) {
  if (acc === "none") return null;
  const common = { fill: "none" as const, stroke: ink, strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <g data-part="accessory" transform="translate(46 46)">
      {acc === "pen" ? <path {...common} d="M2 12 L9 3 M9 3 l2 2 L4 14 l-2.2.4z" /> : null}
      {acc === "wrench" ? <path {...common} d="M3 11 L8 6 M8 6 a2.2 2.2 0 1 1 2.2-2.2 L9 5" /> : null}
      {acc === "coffee" ? <path {...common} d="M3 6 h7 v4 a3 3 0 0 1-3 3 h-1 a3 3 0 0 1-3-3z M10 7 h1.4 a1.6 1.6 0 0 1 0 3.2 H10 M5 3.2 v1.4 M7.4 2.6 v1.6" /> : null}
      {acc === "loupe" ? <g><circle {...common} cx="6" cy="6" r="3.1" /><path {...common} d="M8.4 8.4 L12 12" /></g> : null}
      {acc === "megaphone" ? <path {...common} d="M2 7 h2 l6-3 v8 L4 9 H2 z M10.2 6.2 a2.4 2.4 0 0 1 0 3.6" /> : null}
      {acc === "clipboard" ? <path {...common} d="M4 3 h5 v9 H4 z M5.4 2.2 h2.2 v1.6 H5.4 z M5.2 6.2 h2.6 M5.2 8.2 h2.6" /> : null}
      {acc === "compass" ? <g><circle {...common} cx="6.5" cy="6.5" r="4" /><path {...common} d="M6.5 3.4 L7.6 7.4 L6.5 9.6 L5.4 5.6 z" /></g> : null}
      {acc === "headset" ? <path {...common} d="M3 8 a4 4 0 0 1 8 0 M3 8 v2.4 M11 8 v2.4 M3 11 h1.6 M9.4 11 H11" /> : null}
      {acc === "chart" ? <path {...common} d="M2 12 V3 M2 12 H12 M4 10 V7 M7 10 V5 M10 10 V6" /> : null}
    </g>
  );
}

/** Original pointed-ear Shiba with a dark visor face. No third-party mascot art. */
export function AgentMascot({ look, expression, live = false, label }: {
  look: AgentMascotLook;
  expression?: AgentMascotEyes;
  live?: boolean;
  label?: string;
}): JSX.Element {
  const eyes = expression ?? look.eyes;
  const inner = shade(look.color, -48);
  const ink = "#1c1915";
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
        <path d="M17 31 L23.5 6 L33 28 Z" fill={look.color} />
        <path d="M47 31 L40.5 6 L31 28 Z" fill={look.color} />
      </g>
      <Head shape={look.shape} color={look.color} />
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
        <rect x="18" y="31" width="28" height="15" rx="6" fill="#14161c" />
        <rect x="20" y="32.4" width="24" height="3.2" rx="1.6" fill="#2c3548" />
      </g>
      <g className="shiba-mascot-gaze" data-part="eyes">
        <Eyes kind={eyes} />
      </g>
      <Accessory acc={look.acc} ink={ink} />
    </svg>
  );
}
