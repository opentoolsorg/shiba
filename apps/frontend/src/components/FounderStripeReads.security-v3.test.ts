// @vitest-environment happy-dom
import { createElement, StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FounderStripeReads } from "./FounderStripeReads";
import { STRIPE_ACTOR, STRIPE_WORKSPACE, stripeScope } from "../founder-stripe-fixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps grant review and revoke reachable after StrictMode replays the initial effect", async () => {
  const network = vi.fn(async () => Response.json({ ...stripeScope, available: true, grants: [] })); vi.stubGlobal("fetch", network);
  render(createElement(StrictMode, null, createElement(FounderStripeReads, { workspaceId: STRIPE_WORKSPACE, actorId: STRIPE_ACTOR, onClose() {} })));
  await screen.findByText("Prepare a private Stripe draft");
  expect(screen.getByRole("button", { name: "Refresh Stripe access" })).toHaveProperty("disabled", false);
});
