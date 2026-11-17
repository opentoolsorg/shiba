// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UiBlock } from "@shiba/shared";
import { UiBlockCard } from "./UiBlockCard";
import { UiBlockQuestions } from "./UiBlockQuestions";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const confirm: UiBlock = { version: 1, id: "confirm_it", type: "confirm", prompt: "Continue?", confirmLabel: "Continue", cancelLabel: "Cancel" };
const quick: UiBlock = { version: 1, id: "reply", type: "quick_replies", prompt: "Next?", options: [{ id: "next", label: "Next" }, { id: "delete", label: "Delete", danger: true }] };
const choice: UiBlock = { version: 1, id: "choice", type: "choice", prompt: "Pick", multiple: true, minSelections: 1, maxSelections: 1, options: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] };
const form: UiBlock = { version: 1, id: "details", type: "form", prompt: "Details", fields: [{ id: "name", label: "Name", kind: "text", required: true }, { id: "notes", label: "Notes", kind: "textarea" }, { id: "color", label: "Color", kind: "select", options: [{ id: "blue", label: "Blue" }] }, { id: "agree", label: "Agree", kind: "checkbox" }], submitLabel: "Send details" };
const props = { runId: "web:owner:session", fallbackText: "Fallback question" };
function mockFetch(status = 200, body: unknown = { ok: true }) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("UiBlockCard", () => {
  it("posts a confirmation to the question endpoint and settles without approvals", async () => {
    const fetcher = mockFetch();
    render(<UiBlockCard {...props} block={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Answered: Continue");
    expect(fetcher).toHaveBeenCalledWith("/api/runs/web%3Aowner%3Asession/ui-blocks/confirm_it/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ blockId: "confirm_it", confirmed: true }) }));
    expect(screen.getByRole("button", { name: "Continue" }).closest("fieldset")?.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires two clicks for a dangerous quick reply", async () => {
    const fetcher = mockFetch();
    render(<UiBlockCard {...props} block={quick} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete (destructive)" }));
    expect(screen.getByText("This is destructive — confirm?")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm destructive answer" }));
    await screen.findByText("Answered: Delete");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ blockId: "reply", optionIds: ["delete"], confirmed: true });
  });

  it("requires two clicks for a dangerous confirm and permits cancelling it", async () => {
    const fetcher = mockFetch();
    render(<UiBlockCard {...props} block={{ ...confirm, danger: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Answered: Cancel");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).confirmed).toBe(false);
  });

  it("enforces choice min/max and posts selected ids", async () => {
    const fetcher = mockFetch();
    render(<UiBlockCard {...props} block={choice} />);
    expect((screen.getByRole("button", { name: "Submit answer" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "One" }));
    expect((screen.getByRole("checkbox", { name: "Two" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    await screen.findByText("Answered: One");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).optionIds).toEqual(["one"]);
  });

  it("renders single choices as radios", () => {
    render(<UiBlockCard {...props} block={{ ...choice, multiple: false }} />);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("renders every form field, checks required values, and posts the form", async () => {
    const fetcher = mockFetch();
    render(<UiBlockCard {...props} block={form} />);
    fireEvent.submit(screen.getByRole("button", { name: "Send details" }).closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("required_field:name");
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name (required)"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Notes here" } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "blue" } });
    fireEvent.click(screen.getByLabelText("Agree"));
    fireEvent.submit(screen.getByRole("button", { name: "Send details" }).closest("form")!);
    await screen.findByRole("status");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).values).toEqual({ name: "Ada", notes: "Notes here", color: "blue", agree: true });
  });

  it("renders HTML-like strings literally, including fallback for unknown types and versions", () => {
    const { container, rerender } = render(<UiBlockCard {...props} block={{ ...confirm, prompt: "<img src=x onerror=alert(1)>" }} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    rerender(<UiBlockCard {...props} block={{ type: "future", version: 1 }} fallbackText="<b>Fallback</b>" />);
    expect(screen.getByText("<b>Fallback</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    rerender(<UiBlockCard {...props} block={{ ...confirm, version: 2 }} />);
    expect(screen.getByText("Fallback question")).toBeTruthy();
  });

  it("omits a cleared optional select instead of posting an invalid empty option", async () => {
    const fetcher = mockFetch();
    render(<UiBlockCard {...props} block={form} />);
    fireEvent.change(screen.getByLabelText("Name (required)"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "blue" } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send details" }).closest("form")!);
    await screen.findByRole("status");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).values).toEqual({ name: "Ada" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows server errors without settling", async () => {
    mockFetch(409, { error: "Already answered" });
    render(<UiBlockCard {...props} block={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Already answered");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables settled cards and displays the chosen answer", () => {
    render(<UiBlockCard {...props} block={quick} status="answered" answer={{ blockId: quick.id, optionIds: ["next"] }} />);
    expect(screen.getByRole("status").textContent).toBe("Answered: Next");
    expect(screen.getByRole("button", { name: "Next" }).closest("fieldset")?.disabled).toBe(true);
  });
});

describe("UiBlockQuestions", () => {
  it("fetches the DO thread's questions and mounts question cards", async () => {
    const fetcher = mockFetch(200, { questions: [{ blockId: quick.id, block: quick, fallbackText: "Fallback", status: "pending" }] });
    render(<UiBlockQuestions runId={props.runId} sessionId="session" />);
    await screen.findByRole("button", { name: "Next" });
    expect(fetcher).toHaveBeenCalledWith("/api/runs/web%3Aowner%3Asession/ui-blocks?session=session", expect.any(Object));
  });
  it("handles an empty question list and errors", async () => {
    mockFetch(200, { questions: [] });
    const { unmount } = render(<UiBlockQuestions runId="empty" />);
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    unmount();
    mockFetch(503);
    render(<UiBlockQuestions runId="unavailable" />);
    expect((await screen.findByRole("alert")).textContent).toContain("503");
  });
});
