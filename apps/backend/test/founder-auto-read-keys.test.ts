import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { defaultReadToken, googleRuntimeFingerprint, scopedGoogleReadToken, verifiedGoogleReadToken } from "../src/founder-auto-read-keys.js";
const workspace=`ws_${"a".repeat(24)}`,other=`ws_${"b".repeat(24)}`,token=`oct_${"a".repeat(43)}`,second=`oct_${"b".repeat(43)}`;
const entry=(workspaceId:string,connectionId:string,value=token)=>({workspaceId,connectionId,operationId:"googleads.campaign_daily_metrics",token:value});
const env=(rows:unknown[])=>({INTERNAL_SIGNING_KEY:"fixture-signing-secret-long-enough-123",OPEN_CONNECTOR_READ_RUNTIME_TOKEN:second,OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS:JSON.stringify(rows)} as unknown as Env);
describe("isolated per-source runtime keys",()=>{
 it("selects the exact workspace and connection without default fallback",()=>{const e=env([entry(workspace,"one"),entry(other,"one",second)]);expect(scopedGoogleReadToken(e,workspace,"one")).toBe(token);expect(scopedGoogleReadToken(e,other,"one")).toBe(second);expect(()=>scopedGoogleReadToken(e,workspace,"missing")).toThrow();expect(defaultReadToken(e)).toBe(second);});
 it("rejects duplicate and invalid same-source entries without poisoning another tenant",()=>{const e=env([entry(workspace,"one"),{...entry(workspace,"one"),token:"bad"},entry(other,"one",second)]);expect(()=>scopedGoogleReadToken(e,workspace,"one")).toThrow();expect(scopedGoogleReadToken(e,other,"one")).toBe(second);expect(defaultReadToken(e)).toBe(second);});
 it("binds key pins to exact workspace, connection and key; rotation requires review",async()=>{const e=env([entry(workspace,"one"),entry(workspace,"two",second)]),pin=await googleRuntimeFingerprint(e,workspace,"one",token);expect(await verifiedGoogleReadToken(e,workspace,"one",pin)).toBe(token);await expect(verifiedGoogleReadToken(e,workspace,"two",pin)).rejects.toThrow();Object.assign(e,{OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS:JSON.stringify([entry(workspace,"one",second)])});await expect(verifiedGoogleReadToken(e,workspace,"one",pin)).rejects.toThrow();await expect(verifiedGoogleReadToken(e,workspace,"one",undefined)).rejects.toThrow();});
});
