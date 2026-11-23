import type { LocalBrowserResult, LocalBrowserUiState } from "./local-browser-contract.js";

interface LocalBrowserBridge {
  getState(): Promise<LocalBrowserUiState>;
  approve(url: string): Promise<LocalBrowserResult>;
  navigate(url: string): Promise<LocalBrowserResult>;
  clickButton(label: string): Promise<LocalBrowserResult>;
  takeOver(): Promise<LocalBrowserUiState>;
  handBack(): Promise<LocalBrowserUiState>;
  stop(): Promise<LocalBrowserUiState>;
  onState(listener: (state: LocalBrowserUiState) => void): () => void;
}

declare global {
  interface Window {
    shibaLocalBrowser?: LocalBrowserBridge;
  }
}

const bridge = window.shibaLocalBrowser;
const address = document.querySelector<HTMLInputElement>("#address");
const form = document.querySelector<HTMLFormElement>("#address-form");
const consent = document.querySelector<HTMLElement>("#consent");
const consentOrigin = document.querySelector<HTMLElement>("#consent-origin");
const approve = document.querySelector<HTMLButtonElement>("#approve");
const controls = document.querySelector<HTMLElement>("#controls");
const approvedOrigin = document.querySelector<HTMLElement>("#approved-origin");
const statePill = document.querySelector<HTMLElement>("#state-pill");
const message = document.querySelector<HTMLElement>("#message");
const nativeStatus = document.querySelector<HTMLElement>("#native-status");
const takeOver = document.querySelector<HTMLButtonElement>("#take-over");
const handBack = document.querySelector<HTMLButtonElement>("#hand-back");
const stop = document.querySelector<HTMLButtonElement>("#stop");
const actionForm = document.querySelector<HTMLFormElement>("#action-form");
const buttonLabel = document.querySelector<HTMLInputElement>("#button-label");
const clickButton = document.querySelector<HTMLButtonElement>("#click-button");

let currentState: LocalBrowserUiState | null = null;
let pendingUrl = "";

function setMessage(text: string): void {
  if (message) message.textContent = text;
}

function render(state: LocalBrowserUiState): void {
  currentState = state;
  const active = state.control.phase === "approved";
  const takeover = state.control.phase === "approved" && state.control.mode === "takeover";
  if (controls) controls.hidden = !active;
  if (consent) consent.hidden = true;
  if (statePill) {
    statePill.textContent = takeover ? "Taken over" : active ? "Approved" : "Stopped";
    statePill.className = `pill${takeover ? " takeover" : active ? " active" : ""}`;
  }
  if (approvedOrigin) approvedOrigin.textContent = active && state.control.phase === "approved" ? `Approved for ${state.control.target.kind === "browser" ? state.control.target.origin : "selected window"}` : "";
  if (takeOver) takeOver.hidden = takeover;
  if (handBack) handBack.hidden = !takeover;
  if (clickButton) clickButton.disabled = !active || takeover;
  if (nativeStatus) nativeStatus.textContent = state.nativeWindow.reason;
  if (!active) setMessage(state.control.phase === "stopped" && state.control.reason === "target-changed" ? "The site changed; approval was revoked. Review it again to continue." : "No site is approved.");
  else setMessage(takeover ? "You have taken over. Local actions are paused." : "Visible actions are enabled only for this approved site.");
}

function requireBridge(): LocalBrowserBridge {
  if (!bridge) throw new Error("The local browser bridge is unavailable.");
  return bridge;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = address?.value.trim() ?? "";
  if (!url) return setMessage("Enter an http or https address.");
  const state = currentState?.control;
  if (state?.phase === "approved") {
    const result = await requireBridge().navigate(url);
    if (result.ok) return setMessage("Navigated within the approved site.");
    if (!result.origin) return setMessage(result.error ?? "That address is not allowed.");
  }
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return setMessage("Only http or https addresses without embedded credentials are allowed.");
    }
    pendingUrl = url;
    if (consentOrigin) consentOrigin.textContent = parsed.origin;
    if (consent) consent.hidden = false;
    setMessage("Confirm approval in this local window.");
  } catch {
    setMessage("Enter a complete http or https address.");
  }
});

approve?.addEventListener("click", async () => {
  const result = await requireBridge().approve(pendingUrl);
  if (!result.ok) return setMessage(result.error ?? "The site could not be opened.");
  if (address) address.value = pendingUrl;
  setMessage("The approved site is visible below.");
});

takeOver?.addEventListener("click", async () => render(await requireBridge().takeOver()));
handBack?.addEventListener("click", async () => render(await requireBridge().handBack()));
stop?.addEventListener("click", async () => {
  pendingUrl = "";
  if (address) address.value = "";
  if (buttonLabel) buttonLabel.value = "";
  render(await requireBridge().stop());
});

actionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const label = buttonLabel?.value.trim() ?? "";
  if (!label) return setMessage("Enter the exact label of a visible page button.");
  const result = await requireBridge().clickButton(label);
  setMessage(result.ok ? (result.clicked ? "Visible button clicked." : "No unique visible button matched that label.") : result.error ?? "Action refused.");
});

bridge?.onState(render);
if (bridge) void bridge.getState().then(render).catch(() => setMessage("The local browser is unavailable."));
