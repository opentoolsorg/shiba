import { deliverableMediaType } from "@shiba/shared";

// Scripts may only come from inline blocks or jsDelivr; nothing can call back to the API.
export const HTML_DELIVERABLE_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'none'; frame-ancestors 'self'";
// The sandbox directive keeps a directly opened URL in an opaque origin, same as the iframe.
const HTML_SANDBOX_CSP = `${HTML_DELIVERABLE_CSP}; sandbox allow-scripts allow-modals`;
const PRINT_SCRIPT = '<script>addEventListener("load",()=>setTimeout(()=>print(),300))</script>';

export interface DeliverableViewOptions {
  /** Render in the viewer instead of forcing a download. Only html and pdf honour it. */
  inline?: boolean;
  /** Append a print trigger to html so "Save as PDF" works from a sandboxed tab. */
  print?: boolean;
}

export function deliverableViewOptions(url: URL): DeliverableViewOptions {
  return { inline: url.searchParams.get("inline") === "1", print: url.searchParams.get("print") === "1" };
}

/** One response shape for every route that serves a stored deliverable. */
export function deliverableResponse(path: string, body: ArrayBuffer, options: DeliverableViewOptions = {}, extra: HeadersInit = {}): Response {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const isHtml = extension === "html";
  const viewable = isHtml || extension === "pdf";
  const inline = options.inline === true && viewable;
  let payload: ArrayBuffer | Uint8Array = body;
  if (isHtml && inline && options.print) payload = new TextEncoder().encode(new TextDecoder().decode(body) + PRINT_SCRIPT);
  const headers = new Headers(extra);
  headers.set("content-type", deliverableMediaType(path)!);
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename="${path.split("/").pop()!}"`);
  headers.set("content-length", String(payload.byteLength));
  headers.set("x-content-type-options", "nosniff");
  if (isHtml) headers.set("content-security-policy", HTML_SANDBOX_CSP);
  else if (extension === "pdf") headers.set("content-security-policy", "frame-ancestors 'self'");
  return new Response(payload as BodyInit, { headers });
}
