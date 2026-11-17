const encoder = new TextEncoder();

export function generateInboundSecret(): string {
  return `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
}

export async function verifyInboundSignature(headers: Headers, body: string, secret: string, nowMs = Date.now()): Promise<string | null> {
  const shiba = ["x-shiba-timestamp", "x-shiba-delivery-id", "x-shiba-signature"].some((name) => headers.has(name));
  const timestamp = headers.get(shiba ? "x-shiba-timestamp" : "webhook-timestamp") ?? "";
  const id = headers.get(shiba ? "x-shiba-delivery-id" : "webhook-id") ?? "";
  const signature = headers.get(shiba ? "x-shiba-signature" : "webhook-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || !id || id.includes(".") || id.length > 256 || Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return null;
  try {
    const keyBytes = shiba ? encoder.encode(secret) : Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const message = encoder.encode(shiba ? `${timestamp}.${id}.${body}` : `${id}.${timestamp}.${body}`);
    const candidates = shiba ? [signature] : signature.split(/\s+/);
    let valid = false;
    for (const candidate of candidates) {
      let bytes: Uint8Array<ArrayBuffer>;
      if (shiba) {
        if (!/^sha256=[a-fA-F0-9]{64}$/.test(candidate)) continue;
        bytes = Uint8Array.from(candidate.slice(7).match(/../g)!, (hex) => parseInt(hex, 16));
      } else {
        if (!candidate.startsWith("v1,")) continue;
        try { bytes = Uint8Array.from(atob(candidate.slice(3)), (c) => c.charCodeAt(0)); }
        catch { continue; }
      }
      valid = await crypto.subtle.verify("HMAC", key, bytes, message) || valid;
    }
    return valid ? id : null;
  } catch { return null; }
}
