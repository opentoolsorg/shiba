/**
 * Worker shim for the built-in dashboard auth lane. The implementation
 * lives in `@shiba/auth` (`packages/auth/src/better-auth.ts`); this module
 * only wires the worker's secret redactor into the package's log paths.
 */
import {
  handleBetterAuth as handleBetterAuthLane,
  resolveBetterAuthUserId as resolveBetterAuthUserIdLane,
  type BetterAuthEnrollmentAdapter,
  type BootstrapVerificationAdapter,
} from "@shiba/auth/better-auth";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import {
  nativeEnrollmentEmailConfiguration,
  sendNativeBootstrapVerification,
  sendNativeEnrollmentVerification,
  sendNativePasswordReset,
} from "./native-enrollment-email.js";
import { isPendingTeamEnrollmentCurrent, validatePendingTeamInvitation } from "./team-workspaces-store.js";

export {
  BETTER_AUTH_BASE_PATH,
  BETTER_AUTH_MIN_SECRET_LENGTH,
  BETTER_AUTH_STATEMENTS,
  BETTER_AUTH_INVITATION_HEADER,
  betterAuthFor,
  ensureBetterAuthSchema,
  enabledBetterAuthProviderIds,
  isBetterAuthConfigured,
  isBetterAuthPath,
} from "@shiba/auth/better-auth";
export type { BetterAuthLaneEnv } from "@shiba/auth/better-auth";

const enrollmentAdapters = new WeakMap<Env, Map<boolean, BetterAuthEnrollmentAdapter>>();
function bootstrapVerificationAdapter(env: Env): BootstrapVerificationAdapter {
  const enabled = nativeEnrollmentEmailConfiguration(env) !== null;
  return { enabled,
    ...(enabled ? {} : { unavailableReason: "The operator must configure a verified BETTER_AUTH_VERIFICATION_FROM sender, SEND_EMAIL, and canonical HTTPS BETTER_AUTH_URL." }),
    sendVerificationEmail: input => sendNativeBootstrapVerification(env, input) };
}
const disabledAdapter = (reason: string): BetterAuthEnrollmentAdapter => ({
  enabled: false,
  unavailableReason: reason,
  validateInvitation: async () => null,
  isEnrollmentCurrent: async () => false,
  sendVerificationEmail: async () => { throw new Error("Verified invitation enrollment is not configured."); },
  sendPasswordResetEmail: async () => { throw new Error("Password reset email is not configured."); },
});
const senderUnavailable = disabledAdapter("The operator must configure a verified BETTER_AUTH_VERIFICATION_FROM sender, SEND_EMAIL, and HTTPS BETTER_AUTH_URL.");

function senderAdapter(env: Env): BetterAuthEnrollmentAdapter {
  return {
    enabled: false,
    validateInvitation: async () => null,
    isEnrollmentCurrent: async () => false,
    sendVerificationEmail: async () => { throw new Error("Invitation enrollment is disabled."); },
    sendPasswordResetEmail: (input) => sendNativePasswordReset(env, input),
  };
}

function enrollmentAdapter(env: Env, enabled: boolean): BetterAuthEnrollmentAdapter {
  const configuration = nativeEnrollmentEmailConfiguration(env);
  if (!configuration) return senderUnavailable;
  let byPolicy = enrollmentAdapters.get(env);
  if (!byPolicy) {
    byPolicy = new Map();
    enrollmentAdapters.set(env, byPolicy);
  }
  let adapter = byPolicy.get(enabled);
  if (!adapter) {
    adapter = enabled
      ? {
          enabled: true,
          validateInvitation: ({ token, email }) => validatePendingTeamInvitation(env, token, email),
          isEnrollmentCurrent: (input) => isPendingTeamEnrollmentCurrent(env, input),
          sendVerificationEmail: (input) => sendNativeEnrollmentVerification(env, input),
          sendPasswordResetEmail: (input) => sendNativePasswordReset(env, input),
        }
      : senderAdapter(env);
    byPolicy.set(enabled, adapter);
  }
  return adapter;
}

export async function handleBetterAuth(
  request: Request,
  env: Env,
  options: { teamMemberPolicyEnabled?: boolean } = {},
): Promise<Response | null> {
  return handleBetterAuthLane(request, env, redactSecrets, enrollmentAdapter(env, options.teamMemberPolicyEnabled === true), bootstrapVerificationAdapter(env));
}

export async function resolveBetterAuthUserId(
  request: Request,
  env: Env,
): Promise<string | null> {
  return resolveBetterAuthUserIdLane(request, env, redactSecrets);
}