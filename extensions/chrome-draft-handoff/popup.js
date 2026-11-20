/**
 * The popup reads the active tab's address once, shows the sanitized form, and
 * writes the draft to a new Shiba tab only when the person clicks. It calls no
 * Shiba API, keeps nothing about the page, and never submits anything: the
 * landing composer holds the draft until its owner sends it.
 */
import {
  DESTINATION_KEY,
  REASON_MESSAGES,
  handoffUrl,
  normalizeDestination,
  sanitizePageUrl,
} from "./handoff.js";

const noticeNode = document.querySelector("#notice");
const pageNode = document.querySelector("#page");
const draftFieldNode = document.querySelector("#draft-field");
const draftNode = document.querySelector("#draft");
const openNode = document.querySelector("#open");
const destinationNode = document.querySelector("#destination");
const optionsNode = document.querySelector("#options");

let destination = null;

function showNotice(reason) {
  noticeNode.textContent = REASON_MESSAGES[reason] ?? REASON_MESSAGES.malformed;
  noticeNode.hidden = false;
}

async function readDestination() {
  const stored = await chrome.storage.local.get(DESTINATION_KEY);
  const result = normalizeDestination(stored[DESTINATION_KEY]);
  return result.ok ? result.origin : null;
}

async function readActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Without the action's activeTab grant Chrome withholds the address entirely.
  if (!tab || typeof tab.url !== "string") return { ok: false, reason: "no-tab-access" };
  return sanitizePageUrl(tab.url);
}

openNode.addEventListener("click", async () => {
  const url = handoffUrl(destination, draftNode.value);
  if (url === null) {
    showNotice("empty-draft");
    return;
  }
  openNode.disabled = true;
  await chrome.tabs.create({ url });
  window.close();
});

optionsNode.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function start() {
  destination = await readDestination();
  destinationNode.textContent = destination ?? "";
  if (destination === null) {
    showNotice("no-destination");
    return;
  }

  const page = await readActivePage();
  if (!page.ok) {
    showNotice(page.reason);
    return;
  }

  pageNode.textContent = page.url;
  pageNode.hidden = false;
  draftNode.value = page.url;
  draftFieldNode.hidden = false;
  openNode.hidden = false;
}

start();
