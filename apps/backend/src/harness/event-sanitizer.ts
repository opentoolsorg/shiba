import { boundTail } from "../security.js";

export type HarnessTextSanitizer = (text: string) => string;

/** Classify protocol fields first. Scrub complete display content before any truncation. */
export function sanitizedEventText(text: string, sanitize?: HarnessTextSanitizer, max = 500, trim = false): string {
  const safe = sanitize ? sanitize(text) : text;
  return boundTail(trim ? safe.trim() : safe, max);
}
