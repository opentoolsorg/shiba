import type { Env } from "./env.js";

export function spacesStub(env: Env, orgId: string, spaceId: string) {
  if (!env.Spaces) throw new Error("spaces_unavailable");
  return env.Spaces.get(env.Spaces.idFromName(`${orgId}:${spaceId}`));
}
