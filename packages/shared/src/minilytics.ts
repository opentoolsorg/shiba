/**
 * Minilytics attribution fields for Dodo Payments checkout metadata.
 * Cookie names match the Minilytics browser script (ml_vid / ml_sid).
 */

export const MINILYTICS_VISITOR_COOKIE = "ml_vid";
export const MINILYTICS_SESSION_COOKIE = "ml_sid";

export const MINILYTICS_SCRIPT_HOST = "https://minilytics.princepal.dev";
export const MINILYTICS_WEBSITE_ID = "6z2l59176o1m005i";
export const MINILYTICS_SCRIPT_SRC = `${MINILYTICS_SCRIPT_HOST}/js/script.js`;

export type MinilyticsAttribution = {
  ml_visitor_id?: string;
  ml_session_id?: string;
};

export type MinilyticsDodoMetadata = Record<string, string> & {
  ml_visitor_id: string;
  ml_session_id: string;
};

/** Parse `ml_vid` / `ml_sid` from a Cookie header value. */
export function parseMinilyticsCookies(cookieHeader: string | null | undefined): MinilyticsAttribution {
  const out: MinilyticsAttribution = {};
  if (!cookieHeader || cookieHeader.trim() === "") return out;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name === MINILYTICS_VISITOR_COOKIE) out.ml_visitor_id = decodeURIComponent(value);
    if (name === MINILYTICS_SESSION_COOKIE) out.ml_session_id = decodeURIComponent(value);
  }
  return out;
}

export function minilyticsAttributionFromRequest(request: Request): MinilyticsAttribution {
  return parseMinilyticsCookies(request.headers.get("Cookie"));
}

/**
 * Merge Minilytics ids into Dodo (or other) payment metadata without dropping keys.
 * Pass explicit attribution when the browser sent ids in the JSON body instead of cookies.
 */
export function mergeMinilyticsIntoMetadata(
  existingMetadata: Record<string, string> | null | undefined,
  attribution?: MinilyticsAttribution | null,
): MinilyticsDodoMetadata {
  const base = existingMetadata ? { ...existingMetadata } : {};
  const from = attribution ?? {};
  return {
    ...base,
    ml_visitor_id: from.ml_visitor_id ?? base.ml_visitor_id ?? "",
    ml_session_id: from.ml_session_id ?? base.ml_session_id ?? "",
  };
}

/** Query params Dodo static checkout links accept for metadata passthrough. */
export function dodoCheckoutAttributionQuery(attribution: MinilyticsAttribution): URLSearchParams {
  const params = new URLSearchParams();
  if (attribution.ml_visitor_id) params.set("metadata_ml_visitor_id", attribution.ml_visitor_id);
  if (attribution.ml_session_id) params.set("metadata_ml_session_id", attribution.ml_session_id);
  return params;
}

export function appendDodoCheckoutAttribution(
  checkoutUrl: string,
  attribution: MinilyticsAttribution,
): string {
  const url = new URL(checkoutUrl);
  const extra = dodoCheckoutAttributionQuery(attribution);
  extra.forEach((value, key) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}
