import {
  MINILYTICS_SCRIPT_SRC,
  MINILYTICS_WEBSITE_ID,
  appendDodoCheckoutAttribution,
  type MinilyticsAttribution,
} from "@shiba/shared";
import { authClient } from "./auth-client";

declare global {
  interface Window {
    minilytics?: ((cmd: "goal" | "identify" | "pageview", a?: unknown, b?: unknown) => void) & {
      attribution?: () => MinilyticsAttribution;
    };
  }
}

const SCRIPT_SELECTOR = `script[data-website-id="${MINILYTICS_WEBSITE_ID}"]`;

export function ensureMinilyticsScript(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(SCRIPT_SELECTOR)) return;
  const script = document.createElement("script");
  script.defer = true;
  script.dataset.websiteId = MINILYTICS_WEBSITE_ID;
  script.src = MINILYTICS_SCRIPT_SRC;
  document.head.appendChild(script);
}

export function readMinilyticsAttribution(): MinilyticsAttribution {
  return window.minilytics?.attribution?.() ?? {};
}

export function dodoCheckoutUrlWithAttribution(checkoutUrl: string): string {
  return appendDodoCheckoutAttribution(checkoutUrl, readMinilyticsAttribution());
}

export function trackMinilyticsGoal(goal: string, plan?: string): void {
  if (plan) {
    window.minilytics?.("goal", goal, { plan });
    return;
  }
  window.minilytics?.("goal", goal);
}

export type MinilyticsIdentifyPayload = {
  user_id: string;
  email?: string;
  name?: string;
};

export async function identifyMinilyticsUser(fallbackUserId?: string | null): Promise<void> {
  let payload: MinilyticsIdentifyPayload | null = null;
  try {
    const session = await authClient.getSession();
    const user = session.data?.user;
    if (user && typeof user.id === "string" && user.id !== "") {
      payload = {
        user_id: user.id,
        email: typeof user.email === "string" ? user.email : undefined,
        name: typeof user.name === "string" ? user.name : undefined,
      };
    }
  } catch {
    // Session endpoint may be dark (Access-only deploy); fall back below.
  }
  if (!payload && fallbackUserId && fallbackUserId.trim() !== "") {
    const id = fallbackUserId.trim();
    payload = id.includes("@") ? { user_id: id, email: id } : { user_id: id };
  }
  if (!payload) return;
  window.minilytics?.("identify", payload);
}
