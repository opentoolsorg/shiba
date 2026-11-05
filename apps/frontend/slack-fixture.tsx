import React from "react";
import { createRoot } from "react-dom/client";
import { SlackDraftSubmission } from "./src/components/SlackDraftSubmission";
import { personalFixture, PERSONAL_ACTOR, PERSONAL_WORKSPACE } from "./src/personal-execution-fixtures";
import "./src/styles.css";
const fixture = personalFixture();
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/computers")) return Response.json({computers:[fixture.computer]});
  if (url.endsWith("/grants")) return Response.json({grants:[fixture.grant]});
  if (url.endsWith("/drafts/submit")) {
    const body = JSON.parse(String(init?.body));
    (window as any).submission = body;
    return Response.json({handoffId:"scx_"+"b".repeat(32),state:"queued",approvalRequired:true});
  }
  throw new Error("Fixture denies all other network calls");
};
createRoot(document.getElementById("root")!).render(<main style={{maxWidth:760,margin:"32px auto"}}><p>Local fixture transport only — no Slack or provider requests</p><SlackDraftSubmission workspaceId={PERSONAL_WORKSPACE} actorId={PERSONAL_ACTOR} roomId={"room_"+"a".repeat(24)} draftId={"sd_"+"b".repeat(32)} text="Prepare the public repository summary for review." agents={["agent:fixture"]}/></main>);
