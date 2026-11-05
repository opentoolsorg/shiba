import { boundedBody } from "./json.js";
import { ReadGateError, type GatewayAttemptStore, type GatewayReadReceipt } from "./types.js";
export interface AuthorityBinding { fetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response> }
export function callbackAttempts(binding:AuthorityBinding):GatewayAttemptStore {
  async function call(stage:"claim"|"dispatch"|"complete",input:Parameters<GatewayAttemptStore["commit"]>[0],requestDigest:string,receipt?:GatewayReadReceipt){
    const response=await binding.fetch("https://shiba-authority.internal/internal/founder-automatic-read/permit",{method:"POST",redirect:"manual",headers:{"content-type":"application/json"},body:JSON.stringify({stage,capability:stage==="claim"?input.capabilities.claim:stage==="dispatch"?input.capabilities.dispatch:input.capabilities.complete,requestDigest,...(receipt?{receipt}:{})}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new ReadGateError("read_gate_authority_unconfirmed",409);
    let result:unknown;try{result=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(response.body,80000)));}catch{throw new ReadGateError("read_gate_authority_unconfirmed",409);}
    if(!result||typeof result!=="object"||(result as Record<string,unknown>).ok!==true)throw new ReadGateError("read_gate_authority_unconfirmed",409);
    return result as {ok:true;receipt?:GatewayReadReceipt};
  }
  return {claim:async(input,hash)=>{const row=await call("claim",input,hash);return row.receipt??"claimed";},commit:async(input,hash)=>{await call("dispatch",input,hash);},settle:async(input,hash,receipt)=>{await call("complete",input,hash,receipt);}};
}
