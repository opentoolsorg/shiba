import { z } from "zod";
import { withAuthTimeout } from "./auth-timeout";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),ts=z.string().regex(/^\d{1,16}\.\d{1,9}$/),time=z.number().int().positive();
const binding=z.object({id,teamId:id,slackUserId:id,installationId:id}).strict();
const challenge=binding.extend({state:z.literal('slack_confirmed'),expiresAt:time});
const grant=z.object({id,teamId:id,channelId:id,threadTs:ts,expiresAt:time}).strict();
const draft=z.object({id,text:z.string().min(1).max(4000),teamId:id,channelId:id,threadTs:ts,messageTs:ts,slackUserId:id,eventId:id}).strict();
const state=z.object({bindings:z.array(binding).max(16),challenges:z.array(challenge).max(3),grants:z.array(grant).max(16),executionAvailable:z.literal(false)}).strict();
export type CoworkerDraft=z.infer<typeof draft>;
export type CoworkerState=z.infer<typeof state>;
export class SlackCoworkerClient {
  constructor(readonly workspaceId:string,readonly actorId:string,private readonly fetcher?:typeof fetch) {
    if(!/^ws_[a-f0-9]{24}$/.test(workspaceId)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actorId)||actorId!==actorId.toLowerCase())throw new Error('Native workspace required');
  }
  private async request(path:string,signal:AbortSignal,body?:unknown):Promise<unknown> {
    signal.throwIfAborted();const c=new AbortController(),relay=()=>c.abort();signal.addEventListener('abort',relay,{once:true});
    try{return await withAuthTimeout((async()=>{
      const init:RequestInit={method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:c.signal,headers:{'X-Shiba-Workspace':this.workspaceId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})};
      const response=await (this.fetcher ? this.fetcher.call(globalThis,'/api/slack/coworker'+path,init) : globalThis.fetch('/api/slack/coworker'+path,init));
      c.signal.throwIfAborted();if(!response.ok)throw new Error('Request unavailable');
      const reader=response.body?.getReader(),bytes=new Uint8Array(524288);let used=0;
      try{if(!reader)throw new Error();for(;;){c.signal.throwIfAborted();const part=await reader.read();if(part.done)break;if(used+part.value.length>bytes.length)throw new Error();bytes.set(part.value,used);used+=part.value.length;}c.signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));}finally{await reader?.cancel().catch(()=>{});}
    })(),20_000);}finally{signal.removeEventListener('abort',relay);c.abort();}
  }
  async read(signal:AbortSignal){const [s,d]=await Promise.all([this.request('',signal),this.request('/drafts',signal)]);return {state:state.parse(s),drafts:z.object({drafts:z.array(draft).max(100)}).strict().parse(d).drafts};}
  async begin(installationId:string,signal:AbortSignal){return z.object({id,secret:z.string().regex(/^[a-f0-9]{64}$/),teamId:id,expiresAt:time}).strict().parse(await this.request('/begin',signal,{installationId:id.parse(installationId),reviewed:true}));}
  async confirm(c:z.infer<typeof challenge>,signal:AbortSignal){return z.object({id,slackUserId:id,teamId:id}).strict().parse(await this.request('/confirm',signal,{installationId:c.installationId,challengeId:c.id,slackUserId:c.slackUserId,reviewed:true}));}
  async grant(bindingId:string,channelId:string,threadTs:string,signal:AbortSignal){return z.object({id,channelId:id,threadTs:ts,expiresAt:time}).strict().parse(await this.request('/intake/grant',signal,{bindingId:id.parse(bindingId),channelId:id.parse(channelId),threadTs:ts.parse(threadTs),reviewed:true}));}
  async revoke(path:'/revoke'|'/intake/revoke',value:string,signal:AbortSignal){return z.object({ok:z.literal(true)}).strict().parse(await this.request(path,signal,{id:id.parse(value),reviewed:true}));}
  async submit(draftId:string,roomId:string,recipientActorId:string,personalExecution:{grantId:string;expectedVersion:number},signal:AbortSignal){
    const selection=z.object({id:z.string().regex(/^sd_[a-f0-9]{32}$/),roomId:z.string().regex(/^room_[a-f0-9]{24}$/),recipientActorId:z.string().regex(/^agent:[A-Za-z0-9_-]{1,100}$/),personalExecution:z.object({grantId:z.string().regex(/^plex_[a-f0-9]{32}$/),expectedVersion:z.number().int().positive()}).strict(),reviewed:z.literal(true)}).strict().parse({id:draftId,roomId,recipientActorId,personalExecution,reviewed:true});
    const receipt=z.object({handoffId:z.string().regex(/^scx_[a-f0-9]{32}$/),state:z.enum(['queued','blocked','unknown']),approvalRequired:z.literal(true)}).strict().parse(await this.request('/drafts/submit',signal,selection));
    if(receipt.handoffId!==`scx_${draftId.slice(3)}`)throw new Error('Receipt mismatch');
    return receipt;
  }
  async adopt(value:CoworkerDraft,signal:AbortSignal){const result=draft.parse(await this.request('/drafts/adopt',signal,{id:value.id,reviewed:true}));if(JSON.stringify(result)!==JSON.stringify(value))throw new Error('Draft changed');return result;}
}
