export const NEW_NOTE_INTENT_KEY = "shiba:notes:create-after-navigation";

export function queueNewNoteIntent() {
  try { window.sessionStorage.setItem(NEW_NOTE_INTENT_KEY, "1"); } catch { /* best-effort navigation handoff */ }
}

export function consumeNewNoteIntent() {
  try {
    if (window.sessionStorage.getItem(NEW_NOTE_INTENT_KEY) !== "1") return false;
    window.sessionStorage.removeItem(NEW_NOTE_INTENT_KEY);
    return true;
  } catch {
    return false;
  }
}
