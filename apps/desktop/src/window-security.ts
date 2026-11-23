/**
 * Window policy for every webContents the shell creates. Attached to the
 * default session's contents before the first load, so the rules hold for the
 * dashboard frame, its subframes, and anything a page tries to open.
 */

import {
  authHostUrl,
  decideNavigation,
  externalHandoffUrl,
  isSubframeNavigationAllowed,
  type NavigationDecision,
} from "./navigation.js";

export interface NavigationEvent {
  preventDefault(): void;
  url: string;
}

export interface RedirectEvent extends NavigationEvent {
  /** Electron's deprecated positional flag, still delivered after the details object. */
  isMainFrame?: boolean;
}

export interface FrameNavigationEvent extends NavigationEvent {
  isMainFrame: boolean;
}

export interface WindowOpenDetails {
  url: string;
}

/** The slice of Electron's WebContents the guard needs; a stub satisfies it in tests. */
export interface GuardedContents {
  on(event: "will-navigate", listener: (event: NavigationEvent) => void): unknown;
  on(
    event: "will-redirect",
    listener: (event: RedirectEvent, url: string, isInPlace: boolean, isMainFrame: boolean) => void,
  ): unknown;
  on(event: "will-frame-navigate", listener: (event: FrameNavigationEvent) => void): unknown;
  on(event: "will-attach-webview", listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: (details: WindowOpenDetails) => { action: "deny" }): unknown;
}

export interface WindowGuardDeps {
  configuredOrigin(): string;
  authHosts(): readonly string[];
  /** Hands an already-validated https URL to the OS browser. */
  openExternal(url: string): void;
  /** Optional hook to record refusals; never receives page content. */
  onDecision?(decision: NavigationDecision): void;
}

export interface WindowGuardOptions {
  /** A bundled `file:` page this window may load (the setup page). */
  allowFileUrl?: string;
  /** Additional bundled local pages that may be loaded by their owning window. */
  allowFileUrls?: readonly string[];
}

function sameBundledFile(target: string, fileUrl: string): boolean {
  try {
    const next = new URL(target);
    const allowed = new URL(fileUrl);
    return (
      next.protocol === "file:" &&
      allowed.protocol === "file:" &&
      next.pathname === allowed.pathname
    );
  } catch {
    return false;
  }
}

export function guardWebContents(
  contents: GuardedContents,
  deps: WindowGuardDeps,
  options: WindowGuardOptions = {},
): void {
  const gate = (event: NavigationEvent) => {
    const allowedFiles = [...(options.allowFileUrl ? [options.allowFileUrl] : []), ...(options.allowFileUrls ?? [])];
    if (allowedFiles.some((fileUrl) => sameBundledFile(event.url, fileUrl))) return;
    const origin = deps.configuredOrigin();
    const hosts = deps.authHosts();
    const decision = decideNavigation(event.url, origin, hosts);
    deps.onDecision?.(decision);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") {
      const handoff = externalHandoffUrl(event.url, origin, hosts);
      if (handoff) deps.openExternal(handoff);
    }
  };

  const denySubframe = (event: NavigationEvent) => {
    if (isSubframeNavigationAllowed(event.url, deps.configuredOrigin())) return;
    event.preventDefault();
    deps.onDecision?.("deny");
  };

  contents.on("will-navigate", gate);
  // A redirect can land in a child frame, so it gets the frame policy, never the
  // main-frame one: no OS-browser handoff for a subframe, ever.
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    const mainFrame = event.isMainFrame ?? isMainFrame;
    if (mainFrame) {
      gate(event);
      return;
    }
    denySubframe(event);
  });

  // will-navigate covers the main frame; this one also sees every subframe.
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    denySubframe(event);
  });

  contents.on("will-attach-webview", (event) => event.preventDefault());

  // A popup never loads in this process. A link or an IdP authorization page is
  // handed to the OS browser, where the sign-in can finish and redirect back.
  contents.setWindowOpenHandler(({ url }) => {
    const handoff =
      externalHandoffUrl(url, deps.configuredOrigin(), deps.authHosts()) ??
      authHostUrl(url, deps.authHosts());
    if (handoff) deps.openExternal(handoff);
    else deps.onDecision?.("deny");
    return { action: "deny" };
  });
}
