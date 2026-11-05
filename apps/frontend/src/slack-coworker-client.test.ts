import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackCoworkerClient } from "./slack-coworker-client";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const state = { bindings: [], challenges: [], grants: [], executionAvailable: false };
const workspaceId = `ws_${"a".repeat(24)}`;

describe("Slack coworker client fetch receiver", () => {
  it("uses the global receiver for native fetch and retains injection", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    async function receiverChecked(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const path = String(input); calls.push({ path, init });
      return Response.json(path.endsWith("/drafts") ? { drafts: [] } : state);
    }
    vi.stubGlobal("fetch", receiverChecked);
    const defaultClient = new SlackCoworkerClient(workspaceId, "member@example.test");
    await expect(defaultClient.read(new AbortController().signal)).resolves.toEqual({ state, drafts: [] });
    const injectedClient = new SlackCoworkerClient(workspaceId, "member@example.test", receiverChecked);
    await expect(injectedClient.read(new AbortController().signal)).resolves.toEqual({ state, drafts: [] });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  });
});

const actor='member@example.test',draftId=`sd_${'b'.repeat(32)}`,previewId=`scp_${'c'.repeat(32)}`,roomId=`room_${'d'.repeat(24)}`,hash='e'.repeat(64);
const draft={id:draftId,text:'Reviewed request',teamId:'T1',channelId:'C1',threadTs:'1.1',messageTs:'1.2',slackUserId:'U1',eventId:'E1'};
const snapshot={version:1 as const,grantId:`plex_${'f'.repeat(32)}`,grantVersion:1,ownerAccountId:'account',actorId:actor,workspaceId,membershipVersion:1,machineId:'machine',machineRevision:1,harness:'codex' as const,billingMode:'native-subscription' as const,accountFingerprint:hash,authVersion:hash,codingModel:'openai/model',repoUrl:'https://github.com/owner/repo',expiresAt:Date.now()+60000,allowedPhases:['local_repository_task'] as ['local_repository_task']};
const preview={previewId,draftId,digest:hash,workspaceId,actorId:actor,task:draft.text,roomId,roomTitle:'Room',recipientActorId:'agent:one',employeeName:'One',employeeVersion:1,personalExecution:snapshot,roomAudience:[{actorId:`human:${actor}`,userId:actor,kind:'human',role:'owner'}],createdAt:Date.now(),expiresAt:Date.now()+30000,consent:'share-my-slack-task-and-results-with-reviewed-room-audience'};
const receipt={previewId,draftId,roomId,handoffId:`scx_${'b'.repeat(32)}`,state:'unknown',approvalRequired:true};
describe('Slack coworker reviewed submission',()=>{
  it('checks preview against the selected source and owned grant',async()=>{const fetcher=vi.fn(async()=>Response.json({ok:true,workspaceId,actorId:actor,preview}));const client=new SlackCoworkerClient(workspaceId,actor,fetcher);const selection={requestId:'11111111-1111-4111-8111-111111111111',id:draftId,roomId,recipientActorId:'agent:one',personalExecution:{grantId:snapshot.grantId,expectedVersion:1}};await expect(client.prepareSubmission(selection,draft,snapshot,new AbortController().signal)).resolves.toEqual(preview);await expect(client.prepareSubmission(selection,{...draft,text:'Different'},snapshot,new AbortController().signal)).rejects.toThrow();});
  it('accepts a scoped uncertain receipt from 503 without retrying',async()=>{const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:true,workspaceId,actorId:actor,receipt},{status:503}));const client=new SlackCoworkerClient(workspaceId,actor,fetcher);const parsed=(await import('@shiba/shared')).slackCoworkerSubmissionPreviewSchema.parse(preview);await expect(client.submit(parsed,new AbortController().signal)).resolves.toEqual(receipt);expect(fetcher).toHaveBeenCalledTimes(1);expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({previewId,digest:hash,reviewed:true,audienceConsent:preview.consent});});
  it('does not retry a lost decision and rejects another actor receipt',async()=>{const parsed=(await import('@shiba/shared')).slackCoworkerSubmissionPreviewSchema.parse(preview);const lost=vi.fn(async()=>{throw new Error('lost');});const client=new SlackCoworkerClient(workspaceId,actor,lost);await expect(client.submit(parsed,new AbortController().signal)).rejects.toThrow();expect(lost).toHaveBeenCalledTimes(1);const wrong=new SlackCoworkerClient(workspaceId,actor,async()=>Response.json({ok:true,workspaceId,actorId:'other@example.test',receipt},{status:503}));await expect(wrong.submit(parsed,new AbortController().signal)).rejects.toThrow();});

});
