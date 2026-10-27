import { useEffect, type JSX } from "react";
import { ensureMinilyticsScript, identifyMinilyticsUser } from "../minilytics";

type Props = {
  signedIn: boolean;
  agentName: string | null;
};

/** Injects the Minilytics script once and identifies the viewer when a session exists. */
export function MinilyticsBoot({ signedIn, agentName }: Props): JSX.Element | null {
  useEffect(() => {
    ensureMinilyticsScript();
  }, []);

  useEffect(() => {
    if (!signedIn || !agentName) return;
    void identifyMinilyticsUser(agentName);
  }, [signedIn, agentName]);

  return null;
}
