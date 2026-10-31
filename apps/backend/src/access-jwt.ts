import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

export const ACCESS_EMAIL_HEADER = "CF-Access-Authenticated-User-Email";
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
// Only Cloudflare-hosted team domains: the JWKS URL comes from the token, so it must not be attacker-chosen.
const TEAM_ISSUER = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The token's `iss` picks the allowlisted JWKS; `aud` binds it to our app. */
async function verifiedAccessClaims(token: string, aud: string) {
  try {
    const iss = decodeJwt(token).iss;
    if (typeof iss !== "string" || !TEAM_ISSUER.test(iss)) return null;
    let jwks = jwksByIssuer.get(iss);
    if (!jwks) {
      // ponytail: tiny bounded cache; one team per deploy in practice.
      if (jwksByIssuer.size >= 4) jwksByIssuer.clear();
      jwks = createRemoteJWKSet(new URL(`${iss}/cdn-cgi/access/certs`));
      jwksByIssuer.set(iss, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer: iss, audience: aud, algorithms: ["RS256"] });
    return payload;
  } catch {
    return null;
  }
}

/** Preserve the dashboard's existing email identity semantics. */
export async function verifyAccessJwt(token: string, aud: string): Promise<string | null> {
  const payload = await verifiedAccessClaims(token, aud);
  return typeof payload?.email === "string" && payload.email.trim() !== "" ? payload.email.trim() : null;
}

/** Stable, source/audience-namespaced owner; never trust the email header. */
export async function verifiedAccessOwner(request: Request, aud: string): Promise<string | null> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  const payload = token ? await verifiedAccessClaims(token, aud) : null;
  return typeof payload?.sub === "string" && payload.sub.trim() !== ""
    ? JSON.stringify(["access", payload.iss, aud, payload.sub])
    : null;
}

/**
 * With ACCESS_AUD set, the identity header is rebuilt from a verified Access JWT
 * and a client-sent email header is never trusted.
 */
export async function withVerifiedAccessIdentity(
  request: Request,
  env: { ACCESS_AUD?: string; REQUIRE_ACCESS?: string },
): Promise<Request> {
  const headers = new Headers(request.headers);
  if (env.ACCESS_AUD) {
    const token = request.headers.get(ACCESS_JWT_HEADER);
    const email = token ? await verifyAccessJwt(token, env.ACCESS_AUD) : null;
    if (email) headers.set(ACCESS_EMAIL_HEADER, email);
    else headers.delete(ACCESS_EMAIL_HEADER);
    return new Request(request, { headers });
  }
  // REQUIRE_ACCESS without ACCESS_AUD must not trust a client-sent email header.
  if (env.REQUIRE_ACCESS) {
    headers.delete(ACCESS_EMAIL_HEADER);
    return new Request(request, { headers });
  }
  return request;
}
