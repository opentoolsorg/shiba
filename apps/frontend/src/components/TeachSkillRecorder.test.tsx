// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsView } from "./SkillsView";

function openRecorder() {
  fireEvent.click(screen.getByRole("button", { name: "Run-attached skills" }));
  return within(screen.getByRole("region", { name: "Teach by recording" }));
}

function mockRequests() {
  const posts: Array<{ path: string; body: { name: string; instructions: string } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      return Response.json({
        skill: { id: "skill-recorded", status: "draft", version: 1, createdAt: 1, updatedAt: 1, owned: true, ...body },
      }, { status: 201 });
    }
    return Response.json(path.startsWith("/api/v1/extensions/skills") ? [] : { skills: [] });
  }));
  return posts;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("teach by recording", () => {
  it("proposes only the selected practice steps in order and saves only the reviewed text", async () => {
    const posts = mockRequests();
    render(<SkillsView />);
    const recorder = openRecorder();
    expect(recorder.queryByRole("group", { name: "Practice actions" })).toBeNull();
    fireEvent.click(recorder.getByRole("button", { name: "Start recording" }));
    expect(recorder.getByRole("status")).toHaveTextContent("Recording · 0/20");
    expect(recorder.getByRole("button", { name: "Stop and propose draft" })).toBeDisabled();
    fireEvent.click(recorder.getByRole("button", { name: "Check requirements" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Skill instructions" }), { target: { value: "Unrelated private text" } });
    fireEvent.click(recorder.getByRole("button", { name: "Read the request" }));
    fireEvent.click(recorder.getByRole("button", { name: "Stop and propose draft" }));
    expect(recorder.queryByRole("group", { name: "Practice actions" })).toBeNull();
    expect(recorder.getByRole("textbox", { name: "Proposed instructions" })).toHaveValue(
      "1. Check the requirements and identify what must be left out.\n2. Read the request and identify the intended outcome.",
    );
    expect(screen.getByRole("textbox", { name: "Skill instructions" })).toHaveValue("Unrelated private text");
    const save = recorder.getByRole("button", { name: "Save proposed draft" });
    const review = recorder.getByRole("checkbox", { name: /I’ve reviewed/ });
    expect(save).toBeDisabled();
    fireEvent.click(review);
    expect(save).toBeEnabled();
    fireEvent.change(recorder.getByRole("textbox", { name: "Proposed instructions" }), { target: { value: "Edited handoff instructions." } });
    expect(save).toBeDisabled();
    expect(posts).toEqual([]);
    fireEvent.click(review);
    fireEvent.click(save);
    expect(await recorder.findByRole("status")).toHaveTextContent("Draft saved");
    expect(posts).toEqual([{ path: "/api/skills", body: { name: "Review a support handoff", instructions: "Edited handoff instructions." } }]);
    expect(screen.queryByRole("button", { name: "Activate reviewed version" })).toBeNull();
  });

  it("bounds recording and discards it on cancel, tab hide, or actor change", () => {
    const posts = mockRequests();
    const view = render(<SkillsView actorId="a@example.test" />);
    let recorder = openRecorder();
    fireEvent.click(recorder.getByRole("button", { name: "Start recording" }));
    const action = recorder.getByRole("button", { name: "Preview for review" });
    for (let index = 0; index < 21; index += 1) fireEvent.click(action);
    expect(recorder.getByRole("status")).toHaveTextContent("Recording · 20/20");
    expect(action).toBeDisabled();
    fireEvent.click(recorder.getByRole("button", { name: "Cancel recording" }));
    expect(recorder.getByRole("status")).toHaveTextContent("Recording discarded.");

    fireEvent.click(recorder.getByRole("button", { name: "Start recording" }));
    fireEvent.click(recorder.getByRole("button", { name: "Read the request" }));
    fireEvent.click(recorder.getByRole("button", { name: "Stop and propose draft" }));
    fireEvent.click(recorder.getByRole("button", { name: "Discard proposal" }));
    expect(recorder.getByRole("status")).toHaveTextContent("Proposal discarded.");

    fireEvent.click(recorder.getByRole("button", { name: "Start recording" }));
    fireEvent.click(recorder.getByRole("button", { name: "Read the request" }));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(recorder.getByRole("status")).toHaveTextContent("Recording discarded when you left the page.");
    hidden.mockRestore();

    fireEvent.click(recorder.getByRole("button", { name: "Start recording" }));
    fireEvent.click(recorder.getByRole("button", { name: "Read the request" }));
    fireEvent.click(recorder.getByRole("button", { name: "Stop and propose draft" }));
    view.rerender(<SkillsView actorId="b@example.test" />);
    recorder = openRecorder();
    expect(recorder.queryByRole("heading", { name: "Review proposed skill" })).toBeNull();
    expect(recorder.getByRole("button", { name: "Start recording" })).toBeEnabled();
    expect(posts).toEqual([]);
  });
});
