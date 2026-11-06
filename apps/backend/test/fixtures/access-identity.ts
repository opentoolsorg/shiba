import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

export const TEST_ACCESS_AUD = "test-dashboard-audience";
const TEST_ACCESS_ISSUER = "https://shiba-api-tests.cloudflareaccess.com";
const signer = generateKeyPair("RS256");

/** Route tests use a signed identity. The production JWT verifier stays active. */
export async function verifiedAccessHeaders(email: string): Promise<Record<string, string>> {
  const { privateKey, publicKey } = await signer;
  const jwk = { ...await exportJWK(publicKey), kid: "api-tests", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === `${TEST_ACCESS_ISSUER}/cdn-cgi/access/certs`
      ? Response.json({ keys: [jwk] })
      : new Response("Unexpected test fetch", { status: 500 });
  });
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "api-tests" })
    .setIssuer(TEST_ACCESS_ISSUER).setAudience(TEST_ACCESS_AUD)
    .setSubject(email).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { "Cf-Access-Jwt-Assertion": token };
}
