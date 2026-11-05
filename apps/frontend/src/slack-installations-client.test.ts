import {afterEach,describe,expect,it,vi}from"vitest";
import {SlackInstallationsClient}from"./slack-installations-client";
import {slackInstallationFixture}from"./slack-installations-fixtures";

afterEach(()=>{vi.restoreAllMocks();});
const signal=()=>new AbortController().signal;
function authorize(scopes=["chat:write"]){const url=new URL("https://slack.com/oauth/v2/authorize");url.search=new URLSearchParams({client_id:"123.456",redirect_uri:"https://shiba.test/api/slack/installations/callback",scope:scopes.sort().join(","),state:"s".repeat(43),code_challenge:"c".repeat(43),code_challenge_method:"S256"}).toString();return url;}
describe("native-owner Slack installation client",()=>{
  it("uses explicit scoped HTTP and never launches OAuth during construction or reads",async()=>{
    const state=slackInstallationFixture(),fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json(state)),client=new SlackInstallationsClient(state.workspaceId,state.actorId,fetcher);
    expect(fetcher).not.toHaveBeenCalled();await expect(client.read(signal())).resolves.toEqual(state);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/slack/installations");expect(fetcher.mock.calls[0]?.[1]).toMatchObject({credentials:"same-origin",redirect:"error",referrerPolicy:"no-referrer"});
  });
  it("accepts only the exact reviewed Slack PKCE URL and rejects a substituted scope or redirect",async()=>{
    const state=slackInstallationFixture();let url=authorize();const client=new SlackInstallationsClient(state.workspaceId,state.actorId,async()=>Response.json({ok:true,workspaceId:state.workspaceId,actorId:state.actorId,authorizationUrl:url.href,expiresAt:Date.now()+600_000}));
    const input={requestId:crypto.randomUUID(),scopes:["chat:write"]as("chat:write")[],consent:"install-bot-in-selected-slack-workspace"as const};
    expect((await client.begin(input,signal())).authorizationUrl).toBe(url.href);url=authorize(["chat:write","groups:history"]);await expect(client.begin(input,signal())).rejects.toThrow();
    url=authorize();url.hostname="untrusted.invalid";await expect(client.begin(input,signal())).rejects.toThrow();
  });
  it("pins addressed installation identity and revision on activation",async()=>{
    const initial=slackInstallationFixture(),result=structuredClone(initial),row=initial.installations[0]!;result.installations[0]!.state="active";result.installations[0]!.canActivate=false;
    let wrong=false;const client=new SlackInstallationsClient(initial.workspaceId,initial.actorId,async()=>{const value=structuredClone(result);if(wrong)value.installations[0]!.generation++;return Response.json(value);});
    await expect(client.decide("activate",row,signal())).resolves.toEqual(result);wrong=true;await expect(client.decide("activate",row,signal())).rejects.toThrow();
  });
  it("does not retry denied or cancelled requests and hides raw server text",async()=>{
    const state=slackInstallationFixture(),fetcher=vi.fn(async()=>new Response("sensitive raw upstream text",{status:403})),client=new SlackInstallationsClient(state.workspaceId,state.actorId,fetcher);
    const controller=new AbortController();controller.abort();await expect(client.read(controller.signal)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
    await expect(client.read(signal())).rejects.toMatchObject({message:expect.stringContaining("native workspace-owner access")});expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
