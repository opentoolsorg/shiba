import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

/** Exercise the Worker's real Access verifier with a local, signed test identity. */
export async function signedAccessFixture(team: string, email: string) {
  const issuer = `https://${team}.cloudflareaccess.com`;
  const audience = `${team}-audience`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${issuer}/cdn-cgi/access/certs`) throw new Error("Unexpected network request in Access fixture.");
    return Response.json({ keys: [jwk] });
  });
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { audience, headers: { "Cf-Access-Jwt-Assertion": token } };
}
