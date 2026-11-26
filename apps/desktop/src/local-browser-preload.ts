import { contextBridge, ipcRenderer } from "electron";
import type { LocalBrowserUiState, LocalBrowserResult } from "./local-browser-contract.js";

const CHANNELS = {
  getState: "local-browser:get-state",
  approve: "local-browser:approve",
  navigate: "local-browser:navigate",
  clickButton: "local-browser:click-button",
  takeOver: "local-browser:take-over",
  handBack: "local-browser:hand-back",
  stop: "local-browser:stop",
  stateChanged: "local-browser:state-changed",
} as const;

function isLocalBrowserPage(): boolean {
  return location.protocol === "file:" && /\/local-browser\.html$/.test(location.pathname);
}

if (isLocalBrowserPage()) {
  contextBridge.exposeInMainWorld("shibaLocalBrowser", {
    getState: () => ipcRenderer.invoke(CHANNELS.getState) as Promise<LocalBrowserUiState>,
    approve: (url: string) => ipcRenderer.invoke(CHANNELS.approve, url) as Promise<LocalBrowserResult>,
    navigate: (url: string) => ipcRenderer.invoke(CHANNELS.navigate, url) as Promise<LocalBrowserResult>,
    clickButton: (label: string) =>
      ipcRenderer.invoke(CHANNELS.clickButton, label) as Promise<LocalBrowserResult>,
    takeOver: () => ipcRenderer.invoke(CHANNELS.takeOver) as Promise<LocalBrowserUiState>,
    handBack: () => ipcRenderer.invoke(CHANNELS.handBack) as Promise<LocalBrowserUiState>,
    stop: () => ipcRenderer.invoke(CHANNELS.stop) as Promise<LocalBrowserUiState>,
    onState: (listener: (state: LocalBrowserUiState) => void) => {
      const handler = (_event: unknown, state: LocalBrowserUiState) => listener(state);
      ipcRenderer.on(CHANNELS.stateChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.stateChanged, handler);
    },
  });
}
