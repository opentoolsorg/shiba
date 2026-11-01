/** Same-origin guards for cookie-authenticated dashboard POST/PATCH/DELETE routes. */
export function rejectCrossOriginMutation(request: Request): Response | null {
  const url = new URL(request.url);
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return Response.json(
      { error: "Same-origin request required." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

export function rejectNonJsonMutation(request: Request): Response | null {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return Response.json(
      { error: "Content-Type must be application/json." },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}
