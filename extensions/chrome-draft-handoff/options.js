/**
 * One validated origin is the extension's only stored value. An address that
 * fails validation is reported and left unsaved instead of being repaired, so
 * the handoff never lands somewhere the person did not type.
 */
import { DESTINATION_KEY, REASON_MESSAGES, normalizeDestination } from "./handoff.js";

const formNode = document.querySelector("#form");
const inputNode = document.querySelector("#destination");
const forgetNode = document.querySelector("#forget");
const statusNode = document.querySelector("#status");

function setStatus(text, tone) {
  statusNode.textContent = text;
  statusNode.dataset.tone = tone;
  statusNode.hidden = false;
}

async function showStored() {
  const stored = await chrome.storage.local.get(DESTINATION_KEY);
  const result = normalizeDestination(stored[DESTINATION_KEY]);
  inputNode.value = result.ok ? result.origin : "";
}

formNode.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = normalizeDestination(inputNode.value);
  if (!result.ok) {
    setStatus(REASON_MESSAGES[result.reason] ?? REASON_MESSAGES.malformed, "error");
    return;
  }
  await chrome.storage.local.set({ [DESTINATION_KEY]: result.origin });
  inputNode.value = result.origin;
  setStatus(`Saved ${result.origin}`, "ok");
});

forgetNode.addEventListener("click", async () => {
  await chrome.storage.local.remove(DESTINATION_KEY);
  inputNode.value = "";
  setStatus("Destination forgotten.", "ok");
});

showStored();
