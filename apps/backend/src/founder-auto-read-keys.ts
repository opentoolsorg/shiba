import type { Env } from "./env.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";

const encoder = new TextEncoder();
const tokenPattern = /^oct_[A-Za-z0-9_-]{43}$/;
type KeyEnv = Env & { OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS?: string };
interface Entry { workspaceId: string; connectionId: string; operationId: string; token: string }
interface ParsedRow { value:unknown; duplicate:boolean; workspaces:string[]; connections:string[] }
function rows(env:Env):ParsedRow[] {
  const raw=(env as KeyEnv).OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS;
  if(!raw||encoder.encode(raw).length>32768)return [];
  try {
    const data:unknown=JSON.parse(raw);if(!Array.isArray(data)||data.length>64)return [];
    // Split only on outer array commas while honoring JSON strings and nested values.
    const parts:string[]=[];let start=raw.indexOf("[")+1,depth=0,quoted=false,escape=false;
    for(let i=start;i<raw.length;i++){const c=raw[i]!;if(quoted){if(escape)escape=false;else if(c==="\\")escape=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if(c==="{"||c==="[")depth++;else if(c==="}"||c==="]"){if(c==="]"&&depth===0){if(raw.slice(start,i).trim())parts.push(raw.slice(start,i));break;}depth--;}else if(c===","&&depth===0){parts.push(raw.slice(start,i));start=i+1;}}
    if(parts.length!==data.length)return [];
    return parts.map((part,index)=>{
      const keys=new Set<string>(),workspaces:string[]=[],connections:string[]=[];let duplicate=false;
      const re=/("(?:\\.|[^"\\])*")\s*:\s*/g;
      for(const match of part.matchAll(re)){
        const key=JSON.parse(match[1]!) as string;if(keys.has(key))duplicate=true;keys.add(key);
        if(key==="workspaceId"||key==="connectionId"){
          const value=/^("(?:\\.|[^"\\])*")/.exec(part.slice(match.index!+match[0].length));
          if(value){const decoded=JSON.parse(value[1]!) as string;if(key==="workspaceId")workspaces.push(decoded);else connections.push(decoded);}
        }
      }
      return {value:data[index],duplicate,workspaces,connections};
    });
  } catch { return []; }
}
function valid(v:unknown):v is Entry {
  if(!v||typeof v!=="object"||Array.isArray(v))return false;
  const row=v as Record<string,unknown>;
  return Object.keys(row).sort().join(",")==="connectionId,operationId,token,workspaceId" && typeof row.workspaceId==="string" && /^ws_[a-f0-9]{24}$/.test(row.workspaceId) && typeof row.connectionId==="string" && /^[A-Za-z0-9_:-]{1,200}$/.test(row.connectionId) && row.operationId==="googleads.campaign_daily_metrics" && typeof row.token==="string" && tokenPattern.test(row.token);
}
export function scopedGoogleReadToken(env:Env,workspaceId:string,connectionId:string):string {
  const matches=rows(env).filter(v=>v.workspaces.includes(workspaceId)&&v.connections.includes(connectionId));
  if(matches.length!==1||matches[0]!.duplicate||!valid(matches[0]!.value))throw new WorkspaceIntegrationError("automatic_read_scoped_runtime_unavailable",503);
  return (matches[0]!.value as Entry).token;
}
export function defaultReadToken(env: Env): string {
  if (!tokenPattern.test(env.OPEN_CONNECTOR_READ_RUNTIME_TOKEN ?? "")) throw new WorkspaceIntegrationError("automatic_read_authority_unavailable", 503);
  return env.OPEN_CONNECTOR_READ_RUNTIME_TOKEN!;
}
/** Manifest is public to the authenticated runtime; only select from the current workspace. */
export function workspaceManifestToken(env: Env, workspaceId: string): string {
  try { return defaultReadToken(env); } catch {
    const candidates=rows(env).filter(v=>!v.duplicate&&valid(v.value)).map(v=>v.value as Entry).filter(v=>v.workspaceId===workspaceId);
    for(const candidate of candidates) { try { return scopedGoogleReadToken(env,workspaceId,candidate.connectionId); } catch { /* another entry may be valid */ } }
    throw new WorkspaceIntegrationError("automatic_read_authority_unavailable",503);
  }
}
async function fingerprintKey(env: Env) {
  if(!env.INTERNAL_SIGNING_KEY || env.INTERNAL_SIGNING_KEY.length<32) throw new WorkspaceIntegrationError("automatic_read_authority_unavailable",503);
  return crypto.subtle.importKey("raw",encoder.encode(env.INTERNAL_SIGNING_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
function bound(workspaceId:string,connectionId:string,token:string) { return encoder.encode(JSON.stringify(["shiba.googleads.runtime-key.v1",workspaceId,connectionId,"googleads.campaign_daily_metrics",token])); }
export async function googleRuntimeFingerprint(env:Env,workspaceId:string,connectionId:string,token:string) {
  const signature=await crypto.subtle.sign("HMAC",await fingerprintKey(env),bound(workspaceId,connectionId,token));
  return [...new Uint8Array(signature)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
export async function verifiedGoogleReadToken(env:Env,workspaceId:string,connectionId:string,fingerprint:string|undefined) {
  if(!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new WorkspaceIntegrationError("automatic_read_scoped_runtime_changed",409);
  const token=scopedGoogleReadToken(env,workspaceId,connectionId),bytes=Uint8Array.from(fingerprint.match(/../g)!,v=>Number.parseInt(v,16));
  if(!await crypto.subtle.verify("HMAC",await fingerprintKey(env),bytes,bound(workspaceId,connectionId,token)))throw new WorkspaceIntegrationError("automatic_read_scoped_runtime_changed",409);
  return token;
}
