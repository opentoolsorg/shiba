// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskActivity } from "./TaskActivity";

afterEach(() => {
  cleanup();
});

describe("TaskActivity", () => {
  it("shows only a derived created entry when the task has no activity", () => {
    render(
      <TaskActivity task={{ updatedAt: Date.now(), createdAt: Date.now() }} onComment={vi.fn()} />,
    );

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("You created this task");
    expect(items[0]?.textContent).toContain("just now");
  });

  it("renders changes and comments in time order with resolved actor names", () => {
    const now = Date.now();
    render(
      <TaskActivity
        currentActorId="me"
        actorNames={{ u2: "Asha Rao" }}
        onComment={vi.fn()}
        task={{
          updatedAt: now,
          activity: [
            {
              id: "c1",
              kind: "comment",
              actorId: "u2",
              at: now - 60_000,
              text: "Looks good\nship it",
            },
            {
              id: "s1",
              kind: "change",
              actorId: "me",
              at: now - 3_600_000,
              text: "changed status to running",
            },
            {
              id: "a0",
              kind: "created",
              actorId: "me",
              at: now - 7_200_000,
              text: "created this task",
            },
          ],
        }}
      />,
    );

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("You created this task 2h ago"),
      expect.stringContaining("You changed status to running 1h ago"),
      expect.stringContaining("Asha Rao1m agoLooks good"),
    ]);
  });

  it("sends a trimmed comment on Enter and clears the composer", () => {
    const onComment = vi.fn();
    render(<TaskActivity task={{ updatedAt: Date.now() }} onComment={onComment} />);

    const box = screen.getByRole("textbox", { name: "Leave a comment" });
    fireEvent.change(box, { target: { value: "  Need the logs  " } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onComment).toHaveBeenCalledWith("Need the logs");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send on Shift+Enter and keeps the button disabled while empty", () => {
    const onComment = vi.fn();
    render(<TaskActivity task={{ updatedAt: Date.now() }} onComment={onComment} />);

    const box = screen.getByRole("textbox", { name: "Leave a comment" });
    const button = screen.getByRole("button", { name: "Comment" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onComment).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    expect(onComment).toHaveBeenCalledWith("line one");
  });
});
