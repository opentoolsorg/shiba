// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthScreen } from "./AuthScreen";

const signIn = vi.fn();
const signInSocial = vi.fn();
const signUp = vi.fn();

vi.mock("../auth-client", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => signIn(...args), social: (...args: unknown[]) => signInSocial(...args) },
    signUp: { email: (...args: unknown[]) => signUp(...args) },
  },
}));

afterEach(() => {
  cleanup();
  signIn.mockReset();
  signInSocial.mockReset();
  signUp.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

function fillSignIn(): void {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "owner@example.com" } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "password-123" } });
}

describe("AuthScreen", () => {
  function policies(enabled = true, restricted = false) {
    const fetcher = vi.fn(async (url: string) => ({ ok: true,
      json: async () => url.endsWith("invitation-policy") ? { enabled, reason: enabled ? undefined : "Invitation enrollment is currently unavailable. Contact your workspace owner." }
        : url.endsWith("social-providers") ? { providers: { google: true, slack: true } }
        : url.endsWith("enrollment-status") ? { restricted, emailVerified: !restricted }
        : { requiresToken: false, requiresOwnerEmail: false, locked: false } }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it("uses a captured invitation only in the signup header and waits for independent email verification", async () => {
    const fetcher = policies(); signUp.mockResolvedValue({ data: { user: { emailVerified: false } } });
    const onSignedIn = vi.fn(), token = "b".repeat(64);
    render(<AuthScreen onSignedIn={onSignedIn} invitationToken={token} />);
    await act(async () => {});
    expect((screen.getByLabelText(/invitation token/i) as HTMLInputElement).value).toBe(token);
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Create team account" }));
    expect((await screen.findByText(/check your email and open/i)).textContent).toContain("accept the workspace invitation");
    expect(screen.getByText(/keep this invitation tab open/i).textContent).toContain("reopen the original invitation link");
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ email: "owner@example.com", callbackURL: "/app/?email_verified=1" }),
      expect.objectContaining({ headers: { "x-shiba-workspace-invitation": token } }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(token);
    expect(onSignedIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledWith("/api/auth/send-verification-email", expect.objectContaining({ method: "POST" }));
  });

  it("keeps invitation signup disabled when verified email enrollment is unavailable", async () => {
    policies(false);
    render(<AuthScreen onSignedIn={vi.fn()} invitationToken={"c".repeat(64)} />);
    expect(await screen.findByText(/Invitation enrollment is currently unavailable/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create team account" }) as HTMLButtonElement).disabled).toBe(true);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("offers configured social sign-in only on the existing-account path and disables social signup", async () => {
    policies();
    signInSocial.mockResolvedValue({ data: { url: "https://accounts.google.com/" } });
    render(<AuthScreen onSignedIn={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    await act(async () => {});
    expect(signInSocial).toHaveBeenCalledWith(expect.objectContaining({ provider: "google", requestSignUp: false }));
    fireEvent.click(screen.getByRole("button", { name: "First sign-in? Create the account" }));
    expect(screen.queryByRole("button", { name: "Google" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Slack" })).toBeNull();
  });

  it("shows the provider error reason and keeps linking guidance as a fallback", async () => {
    policies();
    signInSocial.mockResolvedValueOnce({ error: { message: "OAuth provider is not configured" } });
    render(<AuthScreen onSignedIn={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Google" }));
    expect((await screen.findByRole("alert")).textContent).toContain("OAuth provider is not configured");

    signInSocial.mockResolvedValueOnce({ error: { message: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    expect((await screen.findByRole("alert")).textContent).toContain("sign in with email first, then link it in Settings");
  });

  it("does not enter the dashboard with a successful but unverified invited session", async () => {
    policies(true, true); signIn.mockResolvedValue({ data: {} }); const onSignedIn = vi.fn();
    render(<AuthScreen onSignedIn={onSignedIn} />); fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/check your email and open/i)).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("consumes an invite fragment into memory and removes it from browser history", async () => {
    policies(); const token = "d".repeat(64); window.history.replaceState(null, "", `/#invite=${token}`);
    render(<AuthScreen onSignedIn={vi.fn()} />); await act(async () => {});
    expect(window.location.hash).toBe("");
    expect((screen.getByLabelText(/invitation token/i) as HTMLInputElement).value).toBe(token);
  });

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
