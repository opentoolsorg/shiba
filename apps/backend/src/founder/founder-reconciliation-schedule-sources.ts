import { pinGrant, grantFence, type GrantPin } from "./reads/index.js";
import { membershipSql, WorkspaceIntegrationError } from "../workspace-integrations-store.js";
import type { WorkspaceNativeMember } from "../workspace-native-authority.js";
import type { FounderReadsEnv } from "./reads/index.js";

export interface GrantSnapshot { id:string;workspace_id:string;owner_id:string;owner_account_id:string;owner_json:string;account_id:string;revision:number;expires_at:number;fingerprint:string;selection_json:string;contract_digest:string;executor_digest:string;max_calls:number;currency?:string|null;timezone_name?:string|null;mode?:string }
const fail = (): never => { throw new WorkspaceIntegrationError("reconciliation_schedule_source_changed", 409); };

function snapshot(pin: GrantPin<"hubspot">): GrantSnapshot;
function snapshot(pin: GrantPin<"stripe">): GrantSnapshot;
function snapshot(pin: GrantPin<"hubspot" | "stripe">): GrantSnapshot {
  const base = { id:pin.grantId,workspace_id:pin.workspaceId,owner_id:pin.ownerId,owner_account_id:pin.ownerAccountId,owner_json:pin.ownerJson,account_id:pin.accountId,revision:pin.revision,expires_at:pin.expiresAt,fingerprint:pin.fingerprint,selection_json:pin.selectionJson,contract_digest:pin.contractDigest,executor_digest:pin.executorDigest,max_calls:pin.maxCalls };
  if(pin.provider==="hubspot"&&!("mode" in pin.facts))return{...base,currency:pin.facts.currency,timezone_name:pin.facts.timezoneName};
  if(pin.provider==="stripe"&&"mode" in pin.facts)return{...base,mode:pin.facts.mode};
  return fail();
}

function sameOwner(row:string,member:WorkspaceNativeMember){const value=JSON.parse(row) as WorkspaceNativeMember;return value.workspaceId===member.workspaceId&&value.accountId===member.accountId&&value.userId===member.userId&&value.role===member.role&&value.version===member.version;}

export async function currentScheduleGrants(env:FounderReadsEnv,member:WorkspaceNativeMember,hubId:string,stripeId:string,capacity:boolean){
  const need = capacity ? "capacity" : "serving";
  const [hubPin,stripePin] = await Promise.all([
    pinGrant(env,member,{provider:"hubspot",grantId:hubId,need}),
    pinGrant(env,member,{provider:"stripe",grantId:stripeId,need}),
  ]);
  if(!hubPin||!stripePin||!hubPin.facts.currency||!hubPin.facts.timezoneName||JSON.parse(stripePin.selectionJson).kind!=="invoices"||!sameOwner(hubPin.ownerJson,member)||!sameOwner(stripePin.ownerJson,member))return fail();
  return {hub:snapshot(hubPin),stripe:snapshot(stripePin)};
}

function snapshotPin(provider:"hubspot"|"stripe",value:string,member:WorkspaceNativeMember):GrantPin<"hubspot"|"stripe"> {
  const row=JSON.parse(value) as GrantSnapshot;
  if(!sameOwner(row.owner_json,member)||!row.fingerprint) return fail();
  const common={v:1 as const,provider,grantId:row.id,revision:row.revision,workspaceId:row.workspace_id,ownerId:row.owner_id,ownerAccountId:row.owner_account_id,ownerJson:row.owner_json,accountId:row.account_id,fingerprint:row.fingerprint,contractDigest:row.contract_digest,executorDigest:row.executor_digest,selectionJson:row.selection_json,expiresAt:row.expires_at,maxCalls:row.max_calls};
  if(provider==="hubspot") {
    if(row.currency===undefined||row.timezone_name===undefined)return fail();
    return {...common,provider,facts:{currency:row.currency,timezoneName:row.timezone_name}} as GrantPin<"hubspot">;
  }
  if(row.mode!=="live"&&row.mode!=="test")return fail();
  return {...common,provider,facts:{mode:row.mode}} as GrantPin<"stripe">;
}

/** Opaque JSON snapshots retain the durable migration-0076 shape; SQL uses the engine's closed table fences. */
export function frozenGrantsGuard(member:WorkspaceNativeMember,hubJson:string,stripeJson:string,capacity:boolean){
  const hub=snapshotPin("hubspot",hubJson,member),stripe=snapshotPin("stripe",stripeJson,member),need=capacity?"capacity":"serving";
  const ownerFence=membershipSql(member,true),hubFence=grantFence(hub,need),stripeFence=grantFence(stripe,need);
  return {sql:`${ownerFence.sql} AND ${hubFence.sql} AND ${stripeFence.sql}`,values:[...ownerFence.values,...hubFence.values,...stripeFence.values]};
}
