import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { redactSecrets } from "./security.js";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import type { StripeEnv } from "./founder-stripe-store.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
export interface StripeHumanSession {id:string;expiresAt:number}
export async function resolveStripeHumanSession(request:Request,env:StripeEnv,member:WorkspaceNativeMember):Promise<StripeHumanSession|null>{if(!request.headers.has("cookie")||request.headers.has("authorization"))return null;const s=await resolveBetterAuthSessionAccount(request,env,redactSecrets);if(!s?.emailVerified||!s.sessionId||!s.sessionExpiresAt||s.policy.accountId!==member.accountId||s.policy.email!==member.userId||s.sessionExpiresAt<=Date.now())return null;return{id:s.sessionId,expiresAt:s.sessionExpiresAt};}
export function stripeSessionGuard(session:StripeHumanSession,member:WorkspaceNativeMember){return{sql:`EXISTS(SELECT 1 FROM "session" ss WHERE ss.id=? AND ss.userId=? AND CASE WHEN typeof(ss.expiresAt) IN ('integer','real') THEN ss.expiresAt ELSE CAST((julianday(ss.expiresAt)-2440587.5)*86400000 AS INTEGER) END>${FOUNDER_SQL_NOW}) AND ?>${FOUNDER_SQL_NOW}`,values:[session.id,member.accountId,session.expiresAt]};}
export function stripeSessionExpiry(value:string|number){return typeof value==="number"?value:Date.parse(value);}
