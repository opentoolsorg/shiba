// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MentionMenu, activeMention, mentionOptions, useMentionAutocomplete, type MentionMember } from "./MentionAutocomplete";
import { PresenceStack, typingSummary } from "./PresenceStack";

afterEach(cleanup);

const viewer = (id: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ viewerId: `00000000-0000-4000-8000-00000000000${id}`, label, typing: false, cursor: null, status: "online" as const, lastSeenAt: 1, ...extra });

describe("presence stack and typing text", () => {
  it("shows avatars with status, collapses extras", () => {
    const viewers = [viewer("1", "asha@x.test"), viewer("2", "ben@x.test", { status: "away" }), ...[3, 4, 5, 6].map((n) => viewer(String(n), `u${n}@x.test`))];
    render(<PresenceStack viewers={viewers} selfViewerId={viewers[0]!.viewerId} />);
    expect(screen.getByText("asha, online")).toBeTruthy();
    expect(screen.getByText("ben, away")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
  });
  it("names typers, skips self, and lists working employees", () => {
    const viewers = [viewer("1", "me@x.test", { typing: true }), viewer("2", "asha@x.test", { typing: true })];
    expect(typingSummary(viewers, viewers[0]!.viewerId)).toBe("asha is typing…");
    expect(typingSummary(viewers, null, ["Writer"])).toBe("me and asha are typing · Writer is working…");
    expect(typingSummary([viewer("1", "a@x.test")], null)).toBe("");
  });
});

const members: MentionMember[] = [
  { actorId: "human:me@x.test", actorKind: "human", displayName: "Me", userId: "me@x.test", status: "active" },
  { actorId: "human:asha@x.test", actorKind: "human", displayName: "Asha", userId: "asha@x.test", status: "active" },
  { actorId: "agent:writer", actorKind: "agent", displayName: "Writer", userId: "agent:writer", status: "active" },
  { actorId: "human:gone@x.test", actorKind: "human", displayName: "Asher", userId: "gone@x.test", status: "removed" },
];

describe("mention autocomplete", () => {
  it("finds the mention under the caret", () => {
    expect(activeMention("hi @as", 6)).toEqual({ start: 3, query: "as" });
    expect(activeMention("mail a@b.c", 10)).toBeNull();
  });
  it("offers active members except self, using server-parsed tokens", () => {
    expect(mentionOptions(members, "", "me@x.test").map((o) => o.token)).toEqual(["@user:asha@x.test", "@agent:writer"]);
    expect(mentionOptions(members, "wri", "me@x.test").map((o) => o.label)).toEqual(["Writer"]);
  });
  function Composer() {
    const [value, setValue] = useState("");
    const input = useRef<HTMLTextAreaElement>(null);
    const m = useMentionAutocomplete({ members, selfUserId: "me@x.test", value, setValue, input });
    return <div>
      <MentionMenu options={m.options} active={m.active} onPick={m.insert} />
      <textarea aria-label="Message" ref={input} value={value} onChange={(e) => m.onChange(e.target.value, e.target.selectionStart)} onSelect={(e) => m.onSelect(e.currentTarget.selectionStart)} onKeyDown={m.onKeyDown} />
    </div>;
  }
  it("navigates with the keyboard and inserts the token", () => {
    render(<Composer />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "ping @", selectionStart: 6 } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("ping @agent:writer ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("Escape closes the menu without inserting", () => {
    render(<Composer />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "@a", selectionStart: 2 } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.value).toBe("@a");
  });
});
