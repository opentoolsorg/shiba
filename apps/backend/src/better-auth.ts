/**
 * Worker shim for the built-in dashboard auth lane. The implementation
 * lives in `@shiba/auth` (`packages/auth/src/better-auth.ts`); this module
 * only wires the worker's secret redactor into the package's log paths.
 */
import {
  handleBetterAuth as handleBetterAuthLane,
  resolveBetterAuthUserId as resolveBetterAuthUserIdLane,
  type BetterAuthEnrollmentAdapter,
} from "@shiba/auth/better-auth";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { nativeEnrollmentEmailConfiguration, sendNativeEnrollmentVerification } from "./native-enrollment-email.js";
import { isPendingTeamEnrollmentCurrent, validatePendingTeamInvitation } from "./team-workspaces-store.js";

export {
  BETTER_AUTH_BASE_PATH,
  BETTER_AUTH_MIN_SECRET_LENGTH,
  BETTER_AUTH_STATEMENTS,
  BETTER_AUTH_INVITATION_HEADER,
  betterAuthFor,
  ensureBetterAuthSchema,
  isBetterAuthConfigured,
  isBetterAuthPath,
} from "@shiba/auth/better-auth";
export type { BetterAuthLaneEnv } from "@shiba/auth/better-auth";

const enrollmentAdapters = new WeakMap<Env, BetterAuthEnrollmentAdapter>();
const disabledAdapter = (reason: string): BetterAuthEnrollmentAdapter => ({ enabled: false, unavailableReason: reason,
  validateInvitation: async () => null, isEnrollmentCurrent: async () => false,
  sendVerificationEmail: async () => { throw new Error("Verified invitation enrollment is not configured."); } });
const policyDisabled = disabledAdapter("Native team enrollment is unavailable until the team-member API policy is enabled.");
const senderUnavailable = disabledAdapter("The operator must configure a verified BETTER_AUTH_VERIFICATION_FROM sender, SEND_EMAIL, and HTTPS BETTER_AUTH_URL.");
function enrollmentAdapter(env: Env, enabled: boolean): BetterAuthEnrollmentAdapter {
  const configuration = nativeEnrollmentEmailConfiguration(env);
  if (!enabled) return policyDisabled;
  if (!configuration) return senderUnavailable;
  let adapter = enrollmentAdapters.get(env);
  if (!adapter) {
    adapter = { enabled: true,
      validateInvitation: ({ token, email }) => validatePendingTeamInvitation(env, token, email),
      isEnrollmentCurrent: (input) => isPendingTeamEnrollmentCurrent(env, input),
      sendVerificationEmail: (input) => sendNativeEnrollmentVerification(env, input) };
    enrollmentAdapters.set(env, adapter);
  }
  return adapter;
}

export async function handleBetterAuth(
  request: Request,
  env: Env,
  options: { teamMemberPolicyEnabled?: boolean } = {},
): Promise<Response | null> {
  return handleBetterAuthLane(request, env, redactSecrets, enrollmentAdapter(env, options.teamMemberPolicyEnabled === true));
}

export async function resolveBetterAuthUserId(
  request: Request,
  env: Env,
): Promise<string | null> {
  return resolveBetterAuthUserIdLane(request, env, redactSecrets);
}
