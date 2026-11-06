import { slackInstallationDecisionSchema, slackInstallationStartSchema, slackInstallationStateSchema,
  type SlackInstallationPublic, type SlackInstallationStart, type SlackInstallationState } from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";
import { withAuthTimeout } from "./auth-timeout";

export class SlackInstallationRequestError extends Error {
  constructor(readonly status: number) {
    super([401,403,404].includes(status) ? "Current verified native workspace-owner access is unavailable. Refresh before continuing."
      : status === 409 ? "This installation or authorization was already used or changed. Inspect its current status before a new explicit action."
      : "Slack setup is unavailable or its outcome was not confirmed. Check operator configuration and refresh status; do not repeat an uncertain exchange.");
    this.name="SlackInstallationRequestError";
  }
}
export class SlackInstallationsClient {
  private readonly base="/api/slack/installations";
  constructor(readonly workspaceId:string,readonly actorId:string,private readonly fetcher?:typeof fetch) {
    if(!/^ws_[a-f0-9]{24}$/.test(workspaceId)||!actorId||actorId!==actorId.toLowerCase())throw new Error("Select the current native owner and workspace.");
  }
  private async request(path:string,signal:AbortSignal,body?:unknown):Promise<unknown> {
    signal.throwIfAborted();const controller=new AbortController(),relay=()=>controller.abort();signal.addEventListener("abort",relay,{once:true});
    try {
      return await withAuthTimeout((async()=>{
        const init:RequestInit={method:body===undefined?"GET":"POST",credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",signal:controller.signal,
          headers:{...teamWorkspaceHeaders(this.workspaceId),...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})};
        const response=await(this.fetcher?this.fetcher(this.base+path,init):globalThis.fetch(this.base+path,init));controller.signal.throwIfAborted();
        if(!response.ok)throw new SlackInstallationRequestError(response.status);
        const reader=response.body?.getReader(),bytes=new Uint8Array(131_072);let used=0;
        try{if(!reader)throw new Error();for(;;){controller.signal.throwIfAborted();const part=await reader.read();if(part.done)break;if(used+part.value.length>bytes.length)throw new Error();bytes.set(part.value,used);used+=part.value.length;}
          const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,used)));controller.signal.throwIfAborted();return value;
        }catch{throw new Error("Slack setup response could not be verified. Refresh its current status.");}finally{await reader?.cancel().catch(()=>{});}
      })(),20_000);
    }finally{signal.removeEventListener("abort",relay);controller.abort();}
  }
  private state(value:unknown):SlackInstallationState {
    const parsed=slackInstallationStateSchema.safeParse(value);if(!parsed.success)throw new Error("Slack installation status could not be verified.");
    const result=parsed.data;
    if(result.workspaceId!==this.workspaceId||result.actorId!==this.actorId||new Set(result.installations.map((row)=>row.id)).size!==result.installations.length||result.installations.some((row)=>row.workspaceId!==this.workspaceId||row.ownerId!==this.actorId||row.canActivate&&row.state!=="pending"||row.canRefresh&&row.state!=="active"||row.canRevoke&&row.state==="revoked"))throw new Error("Slack installation status belongs to a different owner or workspace, or has stale capabilities.");
    return result;
  }
  async read(signal:AbortSignal):Promise<SlackInstallationState>{return this.state(await this.request("",signal));}
  async begin(input:SlackInstallationStart,signal:AbortSignal):Promise<{authorizationUrl:string;expiresAt:number}> {
    const checked=slackInstallationStartSchema.parse(input),raw=await this.request("/begin",signal,checked) as {ok?:unknown;workspaceId?:unknown;actorId?:unknown;authorizationUrl?:unknown;expiresAt?:unknown};
    if(!raw||raw.ok!==true||raw.workspaceId!==this.workspaceId||raw.actorId!==this.actorId||typeof raw.authorizationUrl!=="string"||raw.authorizationUrl.length>8_192||!Number.isSafeInteger(raw.expiresAt)||Number(raw.expiresAt)<=Date.now()||Number(raw.expiresAt)>Date.now()+610_000)throw new Error("Slack authorization could not be verified. No new window was opened.");
    const url=new URL(raw.authorizationUrl),allowed=["client_id","redirect_uri","scope","state","code_challenge","code_challenge_method"];
    const redirect=new URL(url.searchParams.get("redirect_uri")??"");
    if(url.origin!=="https://slack.com"||url.pathname!=="/oauth/v2/authorize"||url.hash||url.username||url.password||url.port||[...url.searchParams.keys()].some((key)=>!allowed.includes(key))||allowed.some((key)=>url.searchParams.getAll(key).length!==1)||
      !/^[0-9]+\.[0-9]+$/.test(url.searchParams.get("client_id")??"")||url.searchParams.get("code_challenge_method")!=="S256"||!['state','code_challenge'].every((key)=>/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get(key)??""))||
      url.searchParams.get("scope")!==[...checked.scopes].sort().join(",")||redirect.protocol!=="https:"||redirect.username||redirect.password||redirect.port||redirect.search||redirect.hash||redirect.pathname!=="/api/slack/installations/callback")throw new Error("Slack authorization destination or scope does not match your review.");
    return {authorizationUrl:url.href,expiresAt:Number(raw.expiresAt)};
  }
  async decide(action:"activate"|"revoke"|"refresh",row:SlackInstallationPublic,signal:AbortSignal):Promise<SlackInstallationState> {
    const result=this.state(await this.request(`/${encodeURIComponent(row.id)}/${action}`,signal,slackInstallationDecisionSchema.parse({expectedVersion:row.version,digest:row.digest,reviewed:true})));
    const current=result.installations.find((item)=>item.id===row.id);
    if(!current||current.ownerAccountId!==row.ownerAccountId||current.appId!==row.appId||current.teamId!==row.teamId||current.botUserId!==row.botUserId||current.botId!==row.botId||JSON.stringify(current.scopes)!==JSON.stringify(row.scopes)||
      (action==="activate"?(current.state!=="active"||current.digest!==row.digest||current.version!==row.version||current.generation!==row.generation||current.tokenRevision!==row.tokenRevision)
        :action==="revoke"?(current.state!=="revoked"||current.version!==row.version+1||current.generation!==row.generation+1)
          :(current.state!=="active"||current.version!==row.version+1||current.generation!==row.generation||current.tokenRevision!==row.tokenRevision+1)))throw new Error("The exact Slack installation outcome was not confirmed. Refresh and inspect it before another action.");
    return result;
  }
}
