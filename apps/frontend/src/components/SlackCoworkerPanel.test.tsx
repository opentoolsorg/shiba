// @vitest-environment happy-dom
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { SlackCoworkerPanel } from './SlackCoworkerPanel';
import { SlackCoworkerClient } from '../slack-coworker-client';
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
const draft={id:'sd_'+ 'a'.repeat(32),text:'My Slack task',teamId:'T1',channelId:'C1',threadTs:'123.000001',messageTs:'123.000002',slackUserId:'U1',eventId:'E1'};
const state={bindings:[],challenges:[],grants:[],executionAvailable:false};
describe('Slack coworker native scope',()=>{
 it('does not adopt a late result or display a secret after the native actor changes',async()=>{
  const ws='ws_'+ 'a'.repeat(24),oldActor='a@example.test',nextActor='b@example.test',onAdopt=vi.fn();
  let release!:(r:Response)=>void;const held=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(String(url).endsWith('/drafts/adopt'))return held;
    if(String(url).endsWith('/begin'))return Response.json({id:'sc_'+ 'b'.repeat(32),secret:'c'.repeat(64),teamId:'T1',expiresAt:Date.now()+600000});
    if(String(url).endsWith('/drafts'))return Response.json({drafts:[draft]});
    return Response.json(state);
  });
  const next=async(url:RequestInfo|URL)=>Response.json(String(url).endsWith('/drafts')?{drafts:[]}:state);
  const view=render(<SlackCoworkerPanel workspaceId={ws} actorId={oldActor} onAdoptTask={onAdopt} client={new SlackCoworkerClient(ws,oldActor,fetcher)}/>);
  await screen.findByText('My Slack task');
  expect(screen.getByText(/Installing the Slack app is not execution approval/).textContent).toContain('intended channel and thread');
  fireEvent.change(screen.getByLabelText('Managed installation ID'),{target:{value:'I1'}});fireEvent.click(screen.getByRole('button',{name:'Begin identity link'}));
  await screen.findByText(/\/shiba-link/);
  fireEvent.click(screen.getByRole('button',{name:'Review in task composer'}));
  view.rerender(<SlackCoworkerPanel workspaceId={ws} actorId={nextActor} onAdoptTask={onAdopt} client={new SlackCoworkerClient(ws,nextActor,next)}/>);
  await screen.findByText(/Member b@example.test/);
  await act(async()=>{release(Response.json(draft));});
  expect(onAdopt).not.toHaveBeenCalled();expect(screen.queryByText(/\/shiba-link/)).toBeNull();expect(screen.queryByText('My Slack task')).toBeNull();
 });
 it.each([true,false])('clears only the matching Slack-confirmed challenge secret (matching: %s)',async(matching)=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test',challengeId='sc_'+ 'b'.repeat(32);let confirmed=false;
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
    const path=String(url);
    if(path.endsWith('/begin'))return Response.json({id:challengeId,secret:'c'.repeat(64),teamId:'T1',expiresAt:Date.now()+600000});
    return Response.json(path.endsWith('/drafts')?{drafts:[]}:path.endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[]}:{...state,challenges:confirmed?[{id:matching?challengeId:'sc_'+ 'd'.repeat(32),installationId:'I1',teamId:'T1',slackUserId:'U1',state:'slack_confirmed',expiresAt:Date.now()+600000}]:[]});
  });
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);
  await act(async()=>{});
  fireEvent.change(screen.getByLabelText('Managed installation ID'),{target:{value:'I1'}});
  fireEvent.click(screen.getByRole('button',{name:'Begin identity link'}));
  await screen.findByText(/\/shiba-link/);
  confirmed=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await screen.findByRole('button',{name:'Confirm this identity'});
  expect(Boolean(screen.queryByText(/\/shiba-link/))).toBe(!matching);
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/begin'))).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/confirm'))).toBe(false);
  confirmed=false;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await act(async()=>{});
  expect(Boolean(screen.queryByText(/\/shiba-link/))).toBe(!matching);
 });
 it.each([{success:true,matching:true},{success:false,matching:true},{success:true,matching:false},{success:false,matching:false}])('scopes native confirmation secret clearing and fails closed ($success, matching: $matching)',async({success,matching})=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test';let consumed=false;
  const challenge={id:'sc_'+ (matching?'b':'d').repeat(32),installationId:'I1',teamId:'T1',slackUserId:'U1',state:'slack_confirmed',expiresAt:Date.now()+600000};
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
    const path=String(url);
    if(path.endsWith('/begin'))return Response.json({id:'sc_'+ 'b'.repeat(32),secret:'c'.repeat(64),teamId:'T1',expiresAt:Date.now()+600000});
    if(path.endsWith('/confirm')){if(!success)throw new Error('lost response');consumed=true;return Response.json({id:'sb_1',teamId:'T1',slackUserId:'U1'});}
    return Response.json(path.endsWith('/drafts')?{drafts:[]}:path.endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[]}:{...state,challenges:consumed?[]:[challenge],bindings:consumed?[{id:'sb_1',installationId:'I1',teamId:'T1',slackUserId:'U1'}]:[]});
  });
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);
  await screen.findByRole('button',{name:'Confirm this identity'});
  fireEvent.change(screen.getByLabelText('Managed installation ID'),{target:{value:'I1'}});
  fireEvent.click(screen.getByRole('button',{name:'Begin identity link'}));
  await act(async()=>{});
  expect(Boolean(screen.queryByText(/\/shiba-link/))).toBe(!matching);
  fireEvent.click(screen.getByRole('button',{name:'Confirm this identity'}));
  if(success)await screen.findByText('Linked: team T1, Slack user U1');
  else{await screen.findByText(/nothing is retried automatically/);expect((screen.getByRole('button',{name:'Begin identity link'}) as HTMLButtonElement).disabled).toBe(true);}
  expect(Boolean(screen.queryByText(/\/shiba-link/))).toBe(success&&!matching);
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/confirm'))).toHaveLength(1);
 });
 it.each([401,403,500])('clears identity-link instructions only after an auth-denied status refresh (%i)',async(status)=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test';let denied=false;
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
    const path=String(url);
    if(path.endsWith('/begin'))return Response.json({id:'sc_'+ 'b'.repeat(32),secret:'c'.repeat(64),teamId:'T1',expiresAt:Date.now()+600000});
    if(denied)return Response.json({error:'unavailable'},{status});
    return Response.json(path.endsWith('/drafts')?{drafts:[]}:path.endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[]}:state);
  });
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);
  await act(async()=>{});
  fireEvent.change(screen.getByLabelText('Managed installation ID'),{target:{value:'I1'}});
  fireEvent.click(screen.getByRole('button',{name:'Begin identity link'}));
  await screen.findByText(/\/shiba-link/);
  denied=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await screen.findByText('Status could not be verified. Refresh before another action.');
  expect(Boolean(screen.queryByText(/\/shiba-link/))).toBe(status===500);
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/begin'))).toHaveLength(1);
 });
 it.each([1500,-1])('honors the server challenge expiry offset %i without another request',async(offset)=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test';
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
    const path=String(url);
    if(path.endsWith('/begin'))return Response.json({id:'sc_'+ 'b'.repeat(32),secret:'c'.repeat(64),teamId:'T1',expiresAt:Date.now()+offset});
    return Response.json(path.endsWith('/drafts')?{drafts:[]}:path.endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[]}:state);
  });
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);
  await act(async()=>{});vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Managed installation ID'),{target:{value:'I1'}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Begin identity link'}));});
  const calls=fetcher.mock.calls.length;
  if(offset>0){
    expect(screen.getByText(/\/shiba-link/)).toBeTruthy();
    await act(async()=>{await vi.advanceTimersByTimeAsync(offset-1);});
    expect(screen.getByText(/\/shiba-link/)).toBeTruthy();
    await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  }
  expect(screen.queryByText(/\/shiba-link/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(calls);
 });
 it('keeps a receipt visible after its source draft is unavailable',async()=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test',roomId='room_'+ 'd'.repeat(24),handoffId='scx_'+ 'a'.repeat(32),onOpen=vi.fn();
  const receipt={previewId:'scp_'+ 'c'.repeat(32),draftId:draft.id,roomId,handoffId,state:'unknown',approvalRequired:true};
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[receipt]}:String(url).endsWith('/drafts')?{drafts:[]}:state));
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} onOpenHandoff={onOpen} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);
  await screen.findByText(/Submission unknown/);fireEvent.click(screen.getByRole('button',{name:'Open room handoff'}));expect(onOpen).toHaveBeenCalledWith(roomId,handoffId);expect(fetcher.mock.calls.every(([url])=>!String(url).endsWith('/drafts/submit'))).toBe(true);
 });

 it('stops an active private status and refreshes the receipt',async()=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test',roomId='room_'+ 'd'.repeat(24),previewId='scp_'+ 'c'.repeat(32);let revoked=false;
  const row=()=>({previewId,draftId:draft.id,roomId,handoffId:'scx_'+ 'a'.repeat(32),state:'queued',approvalRequired:true,privateStatusState:revoked?'revoked':'active'});
  const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{const path=String(url);if(path.endsWith('/drafts/status/revoke')){revoked=true;return Response.json({ok:true,workspaceId:ws,actorId:actor});}if(path.includes('/drafts/submission?'))return Response.json({ok:true,workspaceId:ws,actorId:actor,preview:null,receipt:row(),sourceAvailable:false});return Response.json(path.endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[row()]}:path.endsWith('/drafts')?{drafts:[]}:state);});
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);await screen.findByText('Private Slack status: active');fireEvent.click(screen.getByText('Stop private Slack status'));await screen.findByText('Private Slack status: revoked');expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/drafts/status/revoke'))).toHaveLength(1);
 });
 it('does not retry an uncertain stop without a verified refresh',async()=>{
  const ws='ws_'+ 'a'.repeat(24),actor='a@example.test',roomId='room_'+ 'd'.repeat(24),previewId='scp_'+ 'c'.repeat(32);const row={previewId,draftId:draft.id,roomId,handoffId:'scx_'+ 'a'.repeat(32),state:'queued',approvalRequired:true,privateStatusState:'active'};
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>{const path=String(url);if(path.endsWith('/drafts/status/revoke'))throw new Error('lost');return Response.json(path.endsWith('/drafts/submissions')?{ok:true,workspaceId:ws,actorId:actor,submissions:[row]}:path.endsWith('/drafts')?{drafts:[]}:state);});
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={()=>{}} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);fireEvent.click(await screen.findByText('Stop private Slack status'));await screen.findByText(/nothing is retried automatically/);expect((screen.getByText('Stop private Slack status') as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByText('Refresh private status'));await screen.findByText(/nothing is retried automatically/);expect((screen.getByText('Stop private Slack status') as HTMLButtonElement).disabled).toBe(true);expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/drafts/status/revoke'))).toHaveLength(1);
 });

});
