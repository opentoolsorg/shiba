import { resolveNativeSession, nativeSessionFence, sessionExpiryMs } from "./native-session.js";
import type { StripeEnv } from "./founder-stripe-store.js";
import type { WorkspaceNativeMember } from "../workspace-native-authority.js";
export interface StripeHumanSession {id:string;expiresAt:number}
export async function resolveStripeHumanSession(request:Request,env:StripeEnv,member:WorkspaceNativeMember):Promise<StripeHumanSession|null>{const session=await resolveNativeSession(request,env,member);return session?{id:session.id,expiresAt:session.expiresAt}:null;}
export function stripeSessionGuard(session:StripeHumanSession,member:WorkspaceNativeMember){const fence=nativeSessionFence({...session,userId:member.accountId},"ss");return fence;}
export function stripeSessionExpiry(value:string|number){return sessionExpiryMs(value)!;}
