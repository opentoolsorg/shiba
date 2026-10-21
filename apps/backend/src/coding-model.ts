import type { Env } from "./env.js";
import { resolveInstanceType } from "./instance-type.js";

/** Fail deploy/dev loudly if wrangler vars still name a retired model. */
const RETIRED_CODING_MODELS = new Set(["google/gemini-2.0-flash"]);

/**
 * Flips only after a non-throwing check, so a retired id keeps failing
 * every request. A fresh Worker starts unverified.
 */
let codingModelVerified = false;

export function assertLiveCodingModel(env: Env): void {
  if (RETIRED_CODING_MODELS.has(env.CODING_MODEL)) {
    throw new Error(
      `CODING_MODEL ${env.CODING_MODEL} is retired. Set wrangler.jsonc vars.CODING_MODEL to a live id.`,
    );
  }
  resolveInstanceType(env.INSTANCE_TYPE);
}

/** Once per isolate, before routes run. A throw leaves the flag unset. */
export function ensureLiveCodingModel(env: Env): void {
  if (codingModelVerified) return;
  assertLiveCodingModel(env);
  codingModelVerified = true;
}

/** Tests share one Worker module. Production never calls this. */
export function resetCodingModelCheck(): void {
  codingModelVerified = false;
}
