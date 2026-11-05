// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { ONBOARDING_DISMISSED_KEY } from './components/AgentExperience';

const mocks=vi.hoisted(()=>({agent:{identified:true,readyState:1,connectionError:null,addEventListener:vi.fn(),removeEventListener:vi.fn(),reconnect:vi.fn()},chat:{messages:[],status:'ready',isStreaming:false,setMessages:vi.fn(),sendMessage:vi.fn(),clearHistory:vi.fn()},router:{history:{replace:(path:string)=>window.history.replaceState(null,'',path),push:(path:string)=>window.history.pushState(null,'',path)}}}));
vi.mock('agents/react',()=>({useAgent:()=>mocks.agent,useAgentToolEvents:()=>({runsById:{}})}));
vi.mock('@cloudflare/ai-chat/react',()=>({useAgentChat:()=>mocks.chat}));
vi.mock('./conversation-room-realtime',()=>({useConversationRoomRealtime:()=>({viewerId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'offline',viewers:[],remoteStream:null,startStream:()=>'',finishStream:vi.fn()})}));
vi.mock('@tanstack/react-router',()=>({useRouter:()=>mocks.router}));
vi.mock('./socket-liveness',()=>({useSocketLiveness:vi.fn()}));
vi.mock('./auth-client',()=>({authClient:{signOut:vi.fn()}}));
vi.mock('./components/FirstRunWizard',()=>({FirstRunWizard:()=>null,ONBOARDING_STORAGE_KEY:'onboarding'}));
vi.mock('./components/ThemeProvider',()=>({useTheme:()=>({resolvedTheme:'light',setTheme:vi.fn()})}));
const actor='member@example.test', workspaceId=`ws_${'a'.repeat(24)}`,otherWorkspace=`ws_${'c'.repeat(24)}`,roomId=`room_${'b'.repeat(24)}`;
const draft={id:`sd_${'a'.repeat(32)}`,text:'Review this Slack statement',teamId:'T1',channelId:'C1',threadTs:'123.000001',messageTs:'123.000002',slackUserId:'U1',eventId:'E1'};
const room={roomId,title:'Team room',visibility:'private'};
const member={roomId,userId:actor,displayName:'Member',actorId:`human:${actor}`,actorKind:'human',role:'member',status:'active'};
const workspaces=[workspaceId,otherWorkspace].map((id,index)=>({workspaceId:id,name:index?'Other team':'Selected team',version:1,createdAt:1,membership:{workspaceId:id,userId:actor,role:'member',version:1,joinedAt:1}}));
let releaseAdopt:((value:Response)=>void)|undefined;
let holdAdopt=false;
let roomActor=actor;
let calls:Array<{path:string;init?:RequestInit}>;
beforeEach(()=>{
 localStorage.clear();localStorage.setItem(ONBOARDING_DISMISSED_KEY,'true');localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`,workspaceId);
 window.history.replaceState(null,'','/integrations/');vi.stubGlobal('WebSocket',undefined);calls=[];holdAdopt=false;roomActor=actor;releaseAdopt=undefined;mocks.chat.sendMessage.mockClear();
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input);calls.push({path,init});
  if(path==='/api/whoami')return Response.json({agent:actor,auth:'better-auth',teamMember:true});
  if(path==='/api/workspaces')return Response.json({workspaces});
  if(path==='/api/slack/coworker')return Response.json({bindings:[],challenges:[],grants:[],executionAvailable:false});
  if(path==='/api/slack/coworker/drafts')return Response.json({drafts:[draft]});
  if(path==='/api/slack/coworker/drafts/adopt'){if(holdAdopt)return new Promise<Response>(resolve=>{releaseAdopt=resolve;});return Response.json(draft);}
  if(path==='/api/collaboration/rooms')return Response.json({rooms:[room]});
  if(path===`/api/collaboration/rooms/${roomId}`)return Response.json({room,currentUserId:roomActor,members:[{...member,userId:roomActor,actorId:`human:${roomActor}`}],messages:[],handoffs:[]});
  return Response.json({workspaces:[],sessions:[],runs:[],approvals:[],decided:[],agents:[],connections:[],computers:[],entries:[]});
 }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();window.history.replaceState(null,'','/');});
async function openDraft(){render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'Review my Slack task drafts'}));return screen.findByRole('button',{name:'Review in task composer'});}
describe('App Slack draft handoff',()=>{
 it('routes an adopted draft into current room review, requiring a second explicit copy and no work submission',async()=>{
  fireEvent.click(await openDraft());
  await screen.findByRole('heading',{name:'Team room'});fireEvent.click(screen.getByRole('tab',{name:'Work'}));
  expect(await screen.findByText(draft.text)).toBeTruthy();expect(screen.getByLabelText('Employee task request')).toHaveProperty('value','');
  fireEvent.click(screen.getByRole('button',{name:'Use Slack draft in this room task'}));
  expect(screen.getByLabelText('Employee task request')).toHaveProperty('value',draft.text);
  expect(screen.getByRole('button',{name:'Request / create handoff'})).toHaveProperty('disabled',true);
  expect(screen.queryByRole('region',{name:'Review Slack draft'})).toBeNull();
  expect(calls.filter(({init})=>init?.method==='POST').map(({path})=>path)).toEqual(['/api/slack/coworker/drafts/adopt']);
  expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  const adopt=calls.find(({path})=>path==='/api/slack/coworker/drafts/adopt');expect(adopt?.init?.headers).toMatchObject({'X-Shiba-Workspace':workspaceId});
 });
 it('does not carry a late adopted result across a workspace switch',async()=>{
  holdAdopt=true;fireEvent.click(await openDraft());await waitFor(()=>expect(releaseAdopt).toBeDefined());
  fireEvent.click(screen.getByRole('button',{name:/(· workspace|^Workspace profile)$/}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Other team'}));
  await act(async()=>{releaseAdopt?.(Response.json(draft));});
  expect(screen.queryByRole('region',{name:'Review Slack draft'})).toBeNull();expect(screen.queryByText(draft.text)).toBeNull();
  expect(calls.filter(({init})=>init?.method==='POST').map(({path})=>path)).toEqual(['/api/slack/coworker/drafts/adopt']);
  expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
 });
 it('withholds the adopted statement if the loaded room has a different native actor',async()=>{
  roomActor='another@example.test';fireEvent.click(await openDraft());
  await screen.findByRole('heading',{name:'Team room'});fireEvent.click(screen.getByRole('tab',{name:'Work'}));
  expect(screen.queryByRole('region',{name:'Review Slack draft'})).toBeNull();
  expect(screen.getByLabelText('Employee task request')).toHaveProperty('value','');
  expect(calls.filter(({init})=>init?.method==='POST').map(({path})=>path)).toEqual(['/api/slack/coworker/drafts/adopt']);
 });
});
