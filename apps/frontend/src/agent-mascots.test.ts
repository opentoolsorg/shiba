import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATES,
  CUSTOM_AGENT_MASCOT_PRESETS,
  CUSTOM_AGENT_ROLE_TEMPLATE_IDS,
  defaultLookFor,
  mascotLookForPreset,
  normalizeAgentMascotLook,
  randomMascotLook,
  resolveAgentMascotLook,
} from "@shiba/shared";
import { avatarStatusFromTask, mascotExpression } from "./agent-mascots";

const key = (look: { shape: string; color: string; eyes: string; acc: string }) => `${look.shape}|${look.color}|${look.eyes}|${look.acc}`;

describe("agent mascot looks", () => {
  it("normalizes a complete look and coerces invalid parts", () => {
    expect(normalizeAgentMascotLook({ shape: "hex", color: "#C4A574", eyes: "star", acc: "pen" })).toEqual({
      shape: "hex", color: "#c4a574", eyes: "star", acc: "pen",
    });
    expect(normalizeAgentMascotLook({ shape: "nope", color: "crimson", eyes: "happy", acc: "mug" })).toEqual({
      shape: "round", color: "#f4e2c4", eyes: "happy", acc: "none",
    });
    expect(normalizeAgentMascotLook({ color: "red" })?.color).toBe("#a65a3a");
    expect(normalizeAgentMascotLook({ color: "#112233" })).toEqual({
      shape: "round", color: "#112233", eyes: "pill", acc: "none",
    });
    expect(normalizeAgentMascotLook(null)).toBeUndefined();
    expect(normalizeAgentMascotLook("hero")).toBeUndefined();
    expect(normalizeAgentMascotLook({ shape: "javascript:alert(1)" })).toBeUndefined();
    expect(normalizeAgentMascotLook({ shape: "pebble", color: "#7ec8e3", eyes: "happy", acc: "none" })?.shape).toBe("pebble");
    expect(normalizeAgentMascotLook({ color: "sky" })?.color).toBe("#7ec8e3");
  });

  it("shuffles and seeds friendly random looks", () => {
    const a = randomMascotLook("seed-a");
    const b = randomMascotLook("seed-b");
    expect(a).toEqual(randomMascotLook("seed-a"));
    expect(a).not.toEqual(b);
    expect(a.shape).toBeTruthy();
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("gives every catalog template and employee role a distinct default", () => {
    const templates = AGENT_TEMPLATES.map((template) => key(defaultLookFor(template.id)));
    expect(new Set(templates).size).toBe(AGENT_TEMPLATES.length);
    const roles = CUSTOM_AGENT_ROLE_TEMPLATE_IDS.map((role) => key(defaultLookFor(`role-${role}`, role)));
    expect(new Set(roles).size).toBe(CUSTOM_AGENT_ROLE_TEMPLATE_IDS.length);
    expect(new Set([...templates, ...roles]).size).toBe(templates.length + roles.length);
    expect(defaultLookFor("coding-coworker")).toEqual(mascotLookForPreset("hero"));
    expect(defaultLookFor("pr-reviewer")).toEqual(mascotLookForPreset("sunglasses"));
    expect(defaultLookFor("shiba")).toEqual(mascotLookForPreset("hero"));
    expect(defaultLookFor("custom-123", "design").shape).toBe("cloud");
  });

  it("maps sticker presets onto unique looks and hashes unknown ids stably", () => {
    const presets = CUSTOM_AGENT_MASCOT_PRESETS.map((preset) => key(mascotLookForPreset(preset)));
    expect(new Set(presets).size).toBe(CUSTOM_AGENT_MASCOT_PRESETS.length);
    const first = defaultLookFor("zzz-unknown");
    const second = defaultLookFor("yyy-unknown");
    expect(first).toEqual(defaultLookFor("zzz-unknown"));
    expect(key(first)).not.toBe(key(second));
    expect(resolveAgentMascotLook({ id: "coding-coworker", preset: "sleeping" })).toEqual(mascotLookForPreset("sleeping"));
    expect(resolveAgentMascotLook({
      id: "coding-coworker",
      preset: "sleeping",
      look: { shape: "bean", color: "#6e8b6a", eyes: "wink", acc: "coffee" },
    })).toEqual({ shape: "bean", color: "#6e8b6a", eyes: "wink", acc: "coffee" });
    expect(resolveAgentMascotLook({ id: "renamed-slug", role: "custom", fallbackId: "custom-123" })).toEqual(defaultLookFor("custom-123"));
  });

  it("maps run status onto a live expression", () => {
    expect(mascotExpression(undefined, "happy")).toBe("happy");
    expect(mascotExpression("idle", "happy")).toBe("happy");
    expect(mascotExpression("working", "happy")).toBe("code");
    expect(mascotExpression("waiting", "happy")).toBe("sleepy");
    expect(mascotExpression("needs-approval", "happy")).toBe("surprised");
    expect(mascotExpression("failed", "happy")).toBe("squint");
    expect(mascotExpression("asleep", "pill")).toBe("sleepy");
  });
});

describe("task avatar status", () => {
  it("does not misrepresent review as an approval requirement", () => {
    expect(avatarStatusFromTask("in-review")).toBe("waiting");
    expect(avatarStatusFromTask("needs-approval")).toBe("needs-approval");
    expect(avatarStatusFromTask("waiting-approval")).toBe("needs-approval");
  });
});
