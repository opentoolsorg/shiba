// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageComposer } from "./ChatMessageComposer";

afterEach(cleanup);

describe("ChatMessageComposer", () => {
  it("keeps send disabled for an empty prompt and submits an ordinary question", () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault());
    const onChange = vi.fn();
    const props = { onChange, onSubmit, onStop: vi.fn(), onRetry: vi.fn(), busy: false, streaming: false, failed: false };
    const { rerender } = render(<ChatMessageComposer value="" {...props} />);
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Shiba" }), { target: { value: "What should we explore?" } });
    expect(onChange).toHaveBeenCalledWith("What should we explore?");
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<ChatMessageComposer value="What should we explore?" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("offers a real stop action while the server response is streaming", () => {
    const onStop = vi.fn();
    render(<ChatMessageComposer value="Draft" onChange={vi.fn()} onSubmit={vi.fn()} onStop={onStop} onRetry={vi.fn()} busy={true} streaming={true} failed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("SHIBA IS RESPONDING");
  });

  it("retries the existing failed turn without resubmitting its user message", () => {
    const onRetry = vi.fn();
    render(<ChatMessageComposer value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()} onRetry={onRetry} busy={false} streaming={false} failed={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry response" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });
});
