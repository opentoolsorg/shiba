// @vitest-environment happy-dom
import {act,cleanup,fireEvent,render,screen,waitFor}from"@testing-library/react";
import {afterEach,describe,expect,it,vi}from"vitest";
import {SlackInstallationsPanel}from"./SlackInstallationsPanel";
import {SlackInstallationsClient}from"../slack-installations-client";
import {slackInstallationFixture}from"../slack-installations-fixtures";

afterEach(()=>{cleanup();vi.restoreAllMocks();});
function authorize(){const url=new URL("https://slack.com/oauth/v2/authorize");url.search=new URLSearchParams({client_id:"123.456",redirect_uri:"https://shiba.test/api/slack/installations/callback",scope:"chat:write",state:"s".repeat(43),code_challenge:"c".repeat(43),code_challenge_method:"S256"}).toString();return url.href;}
describe("scoped Slack installation management",()=>{
  it("loads only status, then requires explicit scope consent before showing an OAuth link",async()=>{
    const state=slackInstallationFixture(),fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>Response.json(init?.method==="POST"?{ok:true,workspaceId:state.workspaceId,actorId:state.actorId,authorizationUrl:authorize(),expiresAt:Date.now()+600_000}:state));
    render(<SlackInstallationsPanel workspaceId={state.workspaceId} actorId={state.actorId} client={new SlackInstallationsClient(state.workspaceId,state.actorId,fetcher)}/>);
    await screen.findByText(/T123 · pending/);expect(fetcher).toHaveBeenCalledTimes(1);expect(screen.queryByRole("link",{name:"Open Slack authorization"})).toBeNull();
    expect(screen.getByRole("button",{name:"Prepare Slack authorization"}).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed these bot scopes/));fireEvent.click(screen.getByRole("button",{name:"Prepare Slack authorization"}));
    const link=await screen.findByRole("link",{name:"Open Slack authorization"});expect(link.getAttribute("href")).toBe(authorize());expect(link.getAttribute("rel")).toBe("noopener noreferrer");expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/does not grant employee execution/)).toBeTruthy();
  });
  it("requires a separate exact pending-install review and cannot auto-activate",async()=>{
    const state=slackInstallationFixture(),fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const value=structuredClone(state);if(init?.method==="POST"){value.installations[0]!.state="active";value.installations[0]!.canActivate=false;}return Response.json(value);});
    render(<SlackInstallationsPanel workspaceId={state.workspaceId} actorId={state.actorId} client={new SlackInstallationsClient(state.workspaceId,state.actorId,fetcher)}/>);
    const activate=await screen.findByRole("button",{name:"Activate reviewed installation"});expect(activate.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed this exact team/));fireEvent.click(activate);
    await screen.findByText(/T123 · active/);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({expectedVersion:1,digest:"a".repeat(64),reviewed:true});
  });
  it("shows missing operator setup honestly and clears cached installation after denied refresh",async()=>{
    const state=slackInstallationFixture();let deny=false;const fetcher=vi.fn(async()=>deny?new Response("denied",{status:401}):Response.json(state));
    render(<SlackInstallationsPanel workspaceId={state.workspaceId} actorId={state.actorId} client={new SlackInstallationsClient(state.workspaceId,state.actorId,fetcher)}/>);
    await screen.findByText(/T123 · pending/);deny=true;fireEvent.click(screen.getByRole("button",{name:"Refresh installation status"}));
    await screen.findByRole("alert");expect(screen.queryByText(/T123 · pending/)).toBeNull();expect(screen.queryByRole("button",{name:"Activate reviewed installation"})).toBeNull();
    cleanup();state.available=false;state.installations=[];render(<SlackInstallationsPanel workspaceId={state.workspaceId} actorId={state.actorId} client={new SlackInstallationsClient(state.workspaceId,state.actorId,async()=>Response.json(state))}/>);
    await screen.findByText(/operator must configure/);expect(screen.getByRole("button",{name:"Prepare Slack authorization"}).hasAttribute("disabled")).toBe(true);
  });
  it("ignores a held authorization result after switching native workspace scope",async()=>{
    const first=slackInstallationFixture(),second=slackInstallationFixture("ws_"+"b".repeat(24),"second@example.test");second.installations=[];
    let release!:(value:Response)=>void;const held=new Promise<Response>((resolve)=>{release=resolve;});
    const oldClient=new SlackInstallationsClient(first.workspaceId,first.actorId,async(_url,init)=>init?.method==="POST"?held:Response.json(first));
    const view=render(<SlackInstallationsPanel workspaceId={first.workspaceId} actorId={first.actorId} client={oldClient}/>);await screen.findByText(/T123 · pending/);
    fireEvent.click(screen.getByLabelText(/I reviewed these bot scopes/));fireEvent.click(screen.getByRole("button",{name:"Prepare Slack authorization"}));
    view.rerender(<SlackInstallationsPanel workspaceId={second.workspaceId} actorId={second.actorId} client={new SlackInstallationsClient(second.workspaceId,second.actorId,async()=>Response.json(second))}/>);
    await screen.findByText(/Owner second@example.test/);
    await act(async()=>{release(Response.json({ok:true,workspaceId:first.workspaceId,actorId:first.actorId,authorizationUrl:authorize(),expiresAt:Date.now()+600_000}));});
    await waitFor(()=>expect(screen.queryByRole("link",{name:"Open Slack authorization"})).toBeNull());
  });
  it("clears cached identity and install actions when explicit authorization loses owner authority",async()=>{
    const state=slackInstallationFixture(),fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>init?.method==="POST"?new Response("denied",{status:403}):Response.json(state));
    render(<SlackInstallationsPanel workspaceId={state.workspaceId} actorId={state.actorId} client={new SlackInstallationsClient(state.workspaceId,state.actorId,fetcher)}/>);
    await screen.findByText(/T123 · pending/);
    fireEvent.click(screen.getByLabelText(/I reviewed these bot scopes/));fireEvent.click(screen.getByRole("button",{name:"Prepare Slack authorization"}));
    await screen.findByRole("alert");expect(screen.queryByText(/T123 · pending/)).toBeNull();expect(screen.queryByRole("button",{name:"Activate reviewed installation"})).toBeNull();
    expect(screen.queryByRole("link",{name:"Open Slack authorization"})).toBeNull();expect(screen.getByRole("button",{name:"Prepare Slack authorization"}).hasAttribute("disabled")).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
