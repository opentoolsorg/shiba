// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("AccountSettings", () => {
  it("renders profile, password, and session controls for better-auth", async () => {
    render(<AccountSettings identity={{ agent: "user@example.test", auth: "better-auth" }} />);
    expect(await screen.findByText("Profile")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(await screen.findByText("TestAgent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });
});