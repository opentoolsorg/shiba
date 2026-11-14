/**
 * Stripe-style webhook signatures for outbound delivery.
 * Header: `X-Shiba-Signature: t=<unix>,v1=<hex>`
 */

export async function signWebhookPayload(secret: string, body: string, timestampSec: number): Promise<string> {
  const signed = `${timestampSec}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSec},v1=${hex}`;
}

export async function verifyWebhookPayload(
  secret: string,
  body: string,
  header: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((piece) => {
      const [k, v] = piece.split("=");
      return [k?.trim(), v?.trim()];
    }),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
  const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  }
  return diff === 0;
}

export function buildDeliveryHeaders(signature: string, deliveryId: string, event: string): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "Shiba-Webhooks/1",
    "x-shiba-signature": signature,
    "x-shiba-delivery-id": deliveryId,
    "x-shiba-event": event,
  });
  return headers;
}