import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { redactSecrets } from "./security.js";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import type { StripeEnv } from "./founder-stripe-store.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
export interface ReconciliationSession {id:string;expiresAt:number}
/** Only a real cookie-resolved native session, never a caller-supplied session selector. */
export async function reconciliationSession(request:Request,env:StripeEnv,member:WorkspaceNativeMember):Promise<ReconciliationSession|null>{if(!request.headers.has("cookie")||request.headers.has("authorization"))return null;const session=await resolveBetterAuthSessionAccount(request,env,redactSecrets);if(!session?.emailVerified||!session.sessionId||!session.sessionExpiresAt||session.policy.accountId!==member.accountId||session.policy.email!==member.userId||session.sessionExpiresAt<=Date.now())return null;return{id:session.sessionId,expiresAt:session.sessionExpiresAt};}
export function reconciliationSessionGuard(session:ReconciliationSession,member:WorkspaceNativeMember){return{sql:`EXISTS(SELECT 1 FROM "session" s WHERE s.id=? AND s.userId=? AND CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE CAST((julianday(s.expiresAt)-2440587.5)*86400000 AS INTEGER) END>${FOUNDER_SQL_NOW}) AND ?>${FOUNDER_SQL_NOW}`,values:[session.id,member.accountId,session.expiresAt]};}
export function reconciliationSessionExpiry(value:string|number){return typeof value==="number"?value:Date.parse(value);}
