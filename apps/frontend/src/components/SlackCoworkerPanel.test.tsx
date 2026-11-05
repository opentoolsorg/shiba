// @vitest-environment happy-dom
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { SlackCoworkerPanel } from './SlackCoworkerPanel';
import { SlackCoworkerClient } from '../slack-coworker-client';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const draft={id:'sd_'+ 'a'.repeat(32),text:'My Slack task',teamId:'T1',channelId:'C1',threadTs:'123.000001',messageTs:'123.000002',slackUserId:'U1',eventId:'E1'};
const state={bindings:[],challenges:[],grants:[],executionAvailable:false};
describe('Slack coworker native scope',()=>{
 it('stages the exact source draft for fenced submission without consuming or copying it',async()=>{
  const onAdopt=vi.fn(),fetcher=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).endsWith('/drafts')?{drafts:[draft]}:state));
  const ws='ws_'+'a'.repeat(24),actor='member@example.test';
  render(<SlackCoworkerPanel workspaceId={ws} actorId={actor} onAdoptTask={onAdopt} client={new SlackCoworkerClient(ws,actor,fetcher)}/>);
  await screen.findByText('My Slack task');
  fireEvent.click(screen.getByRole('button',{name:'Review source-fenced submission'}));
  expect(onAdopt).toHaveBeenCalledWith(draft.text,draft.id);
  expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/drafts/adopt')||String(url).endsWith('/drafts/submit'))).toBe(false);
 });
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
});
