/**
 * Local verify-shiba stand-in: completes publish+review loops without a
 * sandbox when SHIBA_VERIFY_STANDIN=1. Never enabled in production deploys.
 */
export const VERIFY_STANDIN_FLAG = "SHIBA_VERIFY_STANDIN";

export function verifyStandinEnabled(env: { [VERIFY_STANDIN_FLAG]?: string }): boolean {
  return env[VERIFY_STANDIN_FLAG] === "1";
}
