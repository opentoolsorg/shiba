export const LOCAL_BROWSER_CHANNELS = {
  getState: "local-browser:get-state",
  approve: "local-browser:approve",
  navigate: "local-browser:navigate",
  clickButton: "local-browser:click-button",
  takeOver: "local-browser:take-over",
  handBack: "local-browser:hand-back",
  stop: "local-browser:stop",
  stateChanged: "local-browser:state-changed",
} as const;

export interface LocalBrowserUiState {
  control: import("./local-control.js").LocalControlSnapshot;
  nativeWindow: import("./local-browser-policy.js").NativeWindowAvailability;
}

export interface LocalBrowserResult {
  ok: boolean;
  error?: string;
  origin?: string;
  clicked?: boolean;
}
