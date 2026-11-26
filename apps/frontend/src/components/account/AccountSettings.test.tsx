// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSettings } from "./AccountSettings";

vi.mock("../../auth-client", () => ({
  authClient: {
    listSessions: vi.fn(async () => ({ data: [{ token: "s1", userAgent: "TestAgent", ipAddress: "127.0.0.1" }] })),
    updateUser: vi.fn(),
    changePassword: vi.fn(),
    revokeSession: vi.fn(),
    linkSocial: vi.fn(),
    signOut: vi.fn(),
  },
}));

const identity = { agent: "user@example.test", auth: "better-auth" as const };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(verificationStatus = 200) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input) === "/api/auth/send-verification-email"
      ? new Response("{}", { status: verificationStatus })
      : Response.json({ providers: {} }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("AccountSettings", () => {
  it("renders profile, password, and session controls for better-auth", async () => {
    stubFetch();
    render(<AccountSettings identity={identity} />);
    expect(await screen.findByText("Profile")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(await screen.findByText("TestAgent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("keeps the linked sign-in card with an honest empty state when no provider is enabled", async () => {
    stubFetch();
    render(<AccountSettings identity={identity} />);
    expect(await screen.findByText("Linked sign-in methods")).toBeTruthy();
    expect(screen.getByText(/No linked sign-in providers/)).toBeTruthy();
    expect(screen.queryByText(/not connected/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Link / })).toBeNull();
  });

  it("resends the verification email without claiming a verified state", async () => {
    const fetcher = stubFetch();
    render(<AccountSettings identity={identity} />);
    expect(screen.getByText(/Verification status is shown after you open the link in the email/)).toBeTruthy();
    expect(screen.queryByText(/unverified|not verified/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    expect((await screen.findByRole("status")).textContent).toContain("Verification email requested");
    const call = fetcher.mock.calls.find(([url]) => String(url) === "/api/auth/send-verification-email");
    expect(call?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ email: "user@example.test", callbackURL: "/app/?email_verified=1" });
  });

  it("shows a retryable alert when the verification email cannot be sent", async () => {
    stubFetch(500);
    render(<AccountSettings identity={identity} />);
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be sent"));
    expect((screen.getByRole("button", { name: "Resend verification email" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
