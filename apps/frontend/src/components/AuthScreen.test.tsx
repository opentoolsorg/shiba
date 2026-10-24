// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthScreen } from "./AuthScreen";

const signIn = vi.fn();
const signUp = vi.fn();

vi.mock("../auth-client", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => signIn(...args) },
    signUp: { email: (...args: unknown[]) => signUp(...args) },
  },
}));

afterEach(() => {
  cleanup();
  signIn.mockReset();
  signUp.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fillSignIn(): void {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "owner@example.com" } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "password-123" } });
}

describe("AuthScreen", () => {
  it("shows the server error and re-enables the button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ requiresToken: false, requiresOwnerEmail: false, locked: false }) })),
    );
    signIn.mockResolvedValue({ error: { message: "Invalid email or password" } });
    render(<AuthScreen onSignedIn={vi.fn()} />);
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid email or password");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops Working and shows a timeout when sign-in never returns", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ requiresToken: false, requiresOwnerEmail: false, locked: false }) })),
    );
    signIn.mockReturnValue(new Promise(() => {}));
    render(<AuthScreen onSignedIn={vi.fn()} />);
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/did not answer in time/i);
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
