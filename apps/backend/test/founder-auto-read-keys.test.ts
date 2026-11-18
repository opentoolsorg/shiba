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

describe("versioned runtime key fingerprints", () => {
 it.each([undefined,"","short"," ".repeat(32)])("maps an unavailable signing key to 503 (%s)",async(key)=>{
  const e={...env([entry(workspace,"one")]),INTERNAL_SIGNING_KEY:key};
  await expect(googleRuntimeFingerprint(e,workspace,"one",token)).rejects.toMatchObject({code:"automatic_read_authority_unavailable",status:503});
  await expect(verifiedGoogleReadToken(e,workspace,"one","a".repeat(64))).rejects.toMatchObject({code:"automatic_read_authority_unavailable",status:503});
 });
 it("accepts legacy pins only during the signing grace release", async () => {
  const e=env([entry(workspace,"one")]);
  const encoded=new TextEncoder();
  const key=await crypto.subtle.importKey("raw",encoded.encode(e.INTERNAL_SIGNING_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const mac=await crypto.subtle.sign("HMAC",key,encoded.encode(JSON.stringify(["shiba.googleads.runtime-key.v1",workspace,"one","googleads.campaign_daily_metrics",token])));
  const legacy=[...new Uint8Array(mac)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  expect(await verifiedGoogleReadToken(e,workspace,"one",legacy)).toBe(token);
  await expect(verifiedGoogleReadToken({...e,SHIBA_LEGACY_SIGNING_FALLBACK:"0"},workspace,"one",legacy)).rejects.toThrow();
  const current=await googleRuntimeFingerprint(e,workspace,"one",token);
  expect(current).toMatch(/^v1:[a-f0-9]{16}:[a-f0-9]{64}$/);
  expect(await verifiedGoogleReadToken({...e,SHIBA_LEGACY_SIGNING_FALLBACK:"0"},workspace,"one",current)).toBe(token);
 });
});
