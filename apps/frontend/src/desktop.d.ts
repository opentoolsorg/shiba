// T63 — window.shibaDesktop is injected by the desktop preload only when the
// renderer origin equals the configured origin (DESKTOP-PLAN §3.5, D4).
import type { ShibaDesktopBridge } from "@shiba/shared";

declare global {
  interface Window {
    shibaDesktop?: ShibaDesktopBridge;
  }
}
