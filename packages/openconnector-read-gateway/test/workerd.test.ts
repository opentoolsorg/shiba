import { describe,it,expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Reuse the monorepo's declared Wrangler toolchain. No download or production network.
const rootRequire=createRequire(new URL("../../../package.json",import.meta.url));
const tools=createRequire(rootRequire.resolve("wrangler"));
interface FixtureRuntime {dispatchFetch(url:string):Promise<Response>;dispose():Promise<void>}
const {Miniflare,convertV4MiniflareOptions}=tools("miniflare") as {Miniflare:new(options:unknown)=>FixtureRuntime;convertV4MiniflareOptions:(options:Record<string,unknown>)=>unknown};
const {build}=tools("esbuild") as {build:(options:Record<string,unknown>)=>Promise<{outputFiles?:Array<{text:string}>}>};
const entry=fileURLToPath(new URL("../src/index.ts",import.meta.url));
describe("actual workerd fixed-read transport compatibility",()=>{
 it.each([200,302])("uses supported manual redirects and rejects status %i without following",async(status)=>{
  const bundled=await build({stdin:{contents:`
import {handleReadGateway,readGatewayManifest,hash,digest} from ${JSON.stringify(entry)};
export default {async fetch(){const manifest=await readGatewayManifest(),manifestDigest=await hash(manifest),alias='w_'+ 'a'.repeat(32),token='fixture-oauth-token-not-real';
const input={format:'shiba.scheduled-read.v1',versionId:'12345678-1234-1234-1234-123456789abc',manifestDigest,grantId:'far_fixture',grantVersion:2,occurrenceId:'occ_fixture',stepId:'step_fixture',stepDigest:'b'.repeat(64),principal:{kind:'schedule',id:'schedule:far_fixture'},workspaceId:'ws_'+ 'a'.repeat(24),alias,connectionId:'connection',providerConnectionId:'ocg_'+await digest(JSON.stringify([alias,'figma','raw-id','consent'])),authorizationFingerprint:await digest(JSON.stringify([alias,'figma','consent'])),operationId:'figma.get_file_metadata',arguments:{fileKey:'file123'},expiresAt:Date.now()+15000,maxBytes:32768,maxDurationMs:2000,capabilities:{claim:'claim',dispatch:'dispatch',complete:'complete'}};
return handleReadGateway(new Request('https://gate.test/v1/shiba/read-gate/execute',{method:'POST',headers:{authorization:'Bearer fixture-runtime-token-not-real','content-type':'application/json'},body:JSON.stringify(input)}),{enabled:true,version:{id:input.versionId,tag:'c'.repeat(40)},manifest,verifyRuntime:async()=>{},resolveOAuth:async()=>({accessToken:token,rawConnectionId:'raw-id',revision:'r1',consentId:'consent',expiresAt:Date.now()+3600000}),attempts:{claim:async()=> 'claimed',commit:async()=>{},settle:async()=>{}},manualFetch:async()=>new Response('manual')});}};
`,resolveDir:fileURLToPath(new URL("../",import.meta.url)),sourcefile:"gateway-workerd-fixture.ts",loader:"ts"},bundle:true,format:"esm",platform:"browser",target:"es2022",write:false});
  let outward=0;const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:"2026-06-01",script:bundled.outputFiles![0]!.text,outboundService:async(request:Request)=>{outward++;expect(new URL(request.url).hostname).toBe("api.figma.com");return status===302?new Response(null,{status,headers:{location:"https://evil.invalid/collect"}}):Response.json({metadata:{name:"Isolated workerd fixture"}});}}));
  try{const result=await mf.dispatchFetch("https://local.fixture/");expect(result.status).toBe(status===200?200:502);const body=await result.json() as {receipt?:{state?:string};error?:string};expect(status===200?body.receipt?.state:body.error).toBe(status===200?"completed":"read_gate_provider_redirect_denied");expect(outward).toBe(1);}
  finally{await mf.dispose();}
 },30000);
});
