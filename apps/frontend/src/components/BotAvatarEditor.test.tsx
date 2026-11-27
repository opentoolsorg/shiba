// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_AVATAR_COATS, AGENT_AVATAR_VARIANTS, type AgentAvatarChoice } from "@shiba/shared";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";
import { BotAvatarEditor, pillTone, textOnCoat } from "./BotAvatarEditor";

afterEach(cleanup);

const save = () => vi.fn<(choice: AgentAvatarChoice) => void>();
const cancel = vi.fn();

describe("bot avatar editor", () => {
  it("opens on the saved choice and lists the gallery behind the Shapes tab", () => {
    render(<BotAvatarEditor name="Scout" current={{ kind: "variant", variant: AGENT_AVATAR_VARIANTS[2]!.id, color: AGENT_AVATAR_COATS[3]! }} onSave={save()} onCancel={cancel} />);
    expect(screen.getByRole("dialog", { name: "Edit avatar" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Shapes" }).getAttribute("aria-selected")).toBe("true");
    const gallery = screen.getByRole("tabpanel", { name: "Shapes" });
    expect(gallery.querySelectorAll("button").length).toBe(AGENT_AVATAR_VARIANTS.length);
    expect(gallery.querySelector(`button[title="${AGENT_AVATAR_VARIANTS[2]!.label}"]`)?.getAttribute("aria-pressed")).toBe("true");
  });

  it("saves the variant and shell the person picked", async () => {
    const onSave = save();
    render(<BotAvatarEditor name="Scout" onSave={onSave} onCancel={cancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Shell 5" }));
    fireEvent.click(screen.getByRole("tab", { name: "Icons" }));
    const icon = screen.getByRole("tabpanel", { name: "Icons" }).querySelector("button")!;
    fireEvent.click(icon);
    fireEvent.click(screen.getByRole("button", { name: "Save avatar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const choice = onSave.mock.calls[0]![0];
    expect(choice).toMatchObject({ kind: "variant", color: AGENT_AVATAR_COATS[4] });
  });

  it("shuffles to a different variant and stays stable while the dialog is open", () => {
    render(<BotAvatarEditor name="Scout" current={{ kind: "variant", variant: AGENT_AVATAR_VARIANTS[0]!.id, color: AGENT_AVATAR_COATS[0]! }} onSave={save()} onCancel={cancel} />);
    const before = screen.getByRole("dialog").textContent;
    fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
    expect(screen.getByRole("dialog").textContent).not.toBe(before);
  });

  it("cancels without saving on Escape and on the Cancel button", () => {
    const onSave = save();
    const onCancel = vi.fn();
    render(<BotAvatarEditor name="Scout" onSave={onSave} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cycles Tab inside the dialog and pulls focus back in from the page", async () => {
    render(<BotAvatarEditor name="Scout" onSave={save()} onCancel={cancel} />);
    const dialog = screen.getByRole("dialog");
    const controls = [...dialog.querySelectorAll<HTMLElement>("button")];
    // happy-dom reports offsetParent as null for everything, so the trap cannot
    // tell a rendered control from a hidden one without this stub.
    for (const node of controls) Object.defineProperty(node, "offsetParent", { configurable: true, get: () => dialog });
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;

    await waitFor(() => expect(document.activeElement).toBe(first));

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    const behindPage = document.createElement("button");
    document.body.append(behindPage);
    behindPage.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    behindPage.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    behindPage.remove();
  });

  it("shows the server's conflict message and keeps the draft", () => {
    render(<BotAvatarEditor name="Scout" busy={false} error="This bot changed since you opened it. Reload the latest version, then pick the avatar again." onSave={save()} onCancel={cancel} />);
    expect(screen.getByRole("alert").textContent).toContain("changed since you opened it");
    expect(screen.getByRole("button", { name: "Save avatar" })).toBeTruthy();
  });

  it("locks every control while saving", () => {
    render(<BotAvatarEditor name="Scout" busy onSave={save()} onCancel={cancel} />);
    expect(screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Shuffle" }).hasAttribute("disabled")).toBe(true);
  });

  it("says why the upload tab is closed instead of offering a broken button", () => {
    render(<BotAvatarEditor name="Scout" onSave={save()} onCancel={cancel} />);
    fireEvent.click(screen.getByRole("tab", { name: "Upload" }));
    const panel = screen.getByRole("tabpanel", { name: "Upload" });
    expect(panel.textContent).toContain("not available yet");
    expect(panel.querySelector("input[type=file]")).toBeNull();
  });

  it("keeps the name pill readable on every coat", () => {
    const lum = (color: string) => {
      const value = Number.parseInt(color.slice(1), 16);
      const channel = (raw: number) => { const unit = raw / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
    };
    const ratio = (a: string, b: string) => {
      const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (high + 0.05) / (low + 0.05);
    };
    for (const coat of AGENT_AVATAR_COATS) {
      expect(["#222320", "#fafafa"]).toContain(textOnCoat(coat));
      const tone = pillTone(coat);
      expect(ratio(tone.background, tone.color)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

const researchRole: EmployeeRole = "research";

describe("a saved avatar reaches every surface", () => {
  it("draws the saved variant at 20px and 64px instead of the role mark", () => {
    const avatar = { kind: "variant" as const, variant: AGENT_AVATAR_VARIANTS[6]!.id, color: AGENT_AVATAR_COATS[6]! };
    const { container } = render(<div>
      <AgentAvatar id="custom-1" name="Scout" role={researchRole} avatar={avatar} size={20} />
      <AgentAvatar id="custom-1" name="Scout" role={researchRole} avatar={avatar} size={64} />
    </div>);
    const faces = [...container.querySelectorAll("svg.shiba-agent-mascot")];
    expect(faces.length).toBe(2);
    for (const face of faces) {
      expect(face.getAttribute("data-shape")).toBe(AGENT_AVATAR_VARIANTS[6]!.shape);
      expect(face.getAttribute("data-color")).toBe(AGENT_AVATAR_COATS[6]);
      expect(face.getAttribute("data-eyes")).toBe(AGENT_AVATAR_VARIANTS[6]!.eyes);
    }
  });

  it("falls back to the role mark when nothing is saved, and to an uploaded portrait through the file route", () => {
    const { container, rerender } = render(<AgentAvatar id="custom-2" name="Scout" role={researchRole} />);
    expect(container.querySelector("svg.shiba-agent-mascot")?.getAttribute("data-shape")).toBe("pointed");
    rerender(<AgentAvatar id="custom-2" name="Scout" role={researchRole} avatar={{ kind: "upload", fileId: "file_abc12345" }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/files/file_abc12345/download");
  });
});
