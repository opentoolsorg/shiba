import { useEffect, type JSX } from "react";
import { ensureMinilyticsScript } from "../minilytics";

/** Loads the Minilytics script on every dashboard route (including the login screen). */
export function MinilyticsScriptLoader(): JSX.Element | null {
  useEffect(() => {
    ensureMinilyticsScript();
  }, []);
  return null;
}
