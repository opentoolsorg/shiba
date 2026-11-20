// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceBilling } from "@shiba/shared";
import { WorkspaceBillingCard } from "./WorkspaceBillingCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function billing(overrides: Partial<WorkspaceBilling> = {}): WorkspaceBilling {
  return {
    enabled: true, missing: [], mode: "test", creditedUsd: 25, spentUsd: 5.5, pendingUsd: 0, balanceUsd: 19.5, exhausted: false,
    hasCustomer: true, since: Date.UTC(2026, 10, 1), limits: { minUsd: 5, maxUsd: 500 },
    topUps: [{ id: "cs_1", amountUsd: 25, status: "succeeded", createdAt: Date.UTC(2026, 10, 2), settledAt: Date.UTC(2026, 10, 2) }],
    ...overrides,
  };
}

function stub(body: unknown, redirect = "https://checkout.stripe.com/c/pay/cs_2") {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return url.includes("/checkout") || url.includes("/portal") ? Response.json({ url: redirect }) : Response.json(body);
  }));
  return calls;
}

it("shows the balance, what was added and used, and recent top-ups", async () => {
  stub({ billing: billing() });
  render(<WorkspaceBillingCard sessionId="s" sessionApiAvailable={false} />);
  expect(await screen.findByText("$19.50")).toBeTruthy();
  expect(screen.getByText(/\$25\.00 added · \$5\.50 used/)).toBeTruthy();
  expect(screen.getByText("Stripe test mode")).toBeTruthy();
  expect(screen.getByText("Paid")).toBeTruthy();
});

it("sends the chosen amount to Checkout and opens the Stripe URL", async () => {
  const calls = stub({ billing: billing() });
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, search: "" });
  render(<WorkspaceBillingCard sessionId="room 1" sessionApiAvailable />);
  fireEvent.click(await screen.findByRole("button", { name: "$100" }));
  fireEvent.click(screen.getByRole("button", { name: "Add $100" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_2"));
  const checkout = calls.find((call) => call.url.startsWith("/api/billing/checkout"))!;
  expect(checkout.url).toBe("/api/billing/checkout?session=room%201");
  expect(JSON.parse(String(checkout.init?.body))).toEqual({ amountUsd: 100 });
});

it("blocks amounts outside the allowed range", async () => {
  stub({ billing: billing() });
  render(<WorkspaceBillingCard sessionId="s" sessionApiAvailable={false} />);
  fireEvent.change(await screen.findByLabelText("Custom amount in dollars"), { target: { value: "3" } });
  expect((screen.getByRole("button", { name: "Add credits" }) as HTMLButtonElement).disabled).toBe(true);
});

it("warns when credits are spent and disables the portal before a first purchase", async () => {
  stub({ billing: billing({ exhausted: true, balanceUsd: -0.4, hasCustomer: false, topUps: [] }) });
  render(<WorkspaceBillingCard sessionId="s" sessionApiAvailable={false} />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/Out of credits/);
  expect((screen.getByRole("button", { name: "Manage billing" }) as HTMLButtonElement).disabled).toBe(true);
});

it("explains which Worker secrets turn billing on when it is off", async () => {
  stub({ billing: billing({ enabled: false, missing: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], mode: null }) });
  render(<WorkspaceBillingCard sessionId="s" sessionApiAvailable={false} />);
  expect(await screen.findByText(/Billing is off on this deployment/)).toBeTruthy();
  expect(screen.getByText("STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET")).toBeTruthy();
});

it("renders nothing when the route returns no billing payload", async () => {
  stub({ days: [] });
  const { container } = render(<WorkspaceBillingCard sessionId="s" sessionApiAvailable={false} />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});
