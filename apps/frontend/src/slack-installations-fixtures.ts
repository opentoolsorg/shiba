import type { SlackInstallationState } from "@shiba/shared";

/** Deterministic HTTP/UI fixture only; no live account or connection. */
export function slackInstallationFixture(workspaceId="ws_"+"a".repeat(24),actorId="owner@example.test"):SlackInstallationState {
  return {ok:true,workspaceId,actorId,available:true,executionAvailable:false,executionUnavailableReason:"native_slack_actor_and_provider_billing_grant_required",installations:[{
    id:"fixture-installation",workspaceId,ownerId:actorId,ownerAccountId:"fixture-native-account",ownerMembershipVersion:1,appId:"A123",teamId:"T123",enterpriseId:null,botUserId:"U_BOT",botId:"B_BOT",installerSlackUserId:"U_INSTALLER",
    generation:1,version:1,tokenRevision:1,scopes:["chat:write"],expiresAt:Date.now()+3_600_000,state:"pending",digest:"a".repeat(64),activationExpiresAt:Date.now()+600_000,createdAt:Date.now(),canActivate:true,canRevoke:true,canRefresh:false,
  }]};
}
