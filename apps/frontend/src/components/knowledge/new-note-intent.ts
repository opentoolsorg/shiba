export const NEW_NOTE_INTENT_KEY = "shiba:notes:create-after-navigation";

export function queueNewNoteIntent(scope: "personal" | "workspace" = "personal") {
  try { window.sessionStorage.setItem(NEW_NOTE_INTENT_KEY, scope); } catch { /* best-effort navigation handoff */ }
}

export function consumeNewNoteIntent(): "personal" | "workspace" | null {
  try {
    const scope = window.sessionStorage.getItem(NEW_NOTE_INTENT_KEY);
    if (scope !== "personal" && scope !== "workspace") return null;
    window.sessionStorage.removeItem(NEW_NOTE_INTENT_KEY);
    return scope;
  } catch {
    return null;
  }
}
