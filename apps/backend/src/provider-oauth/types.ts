export type UserOAuthProvider = "antigravity" | "cursor" | "xai";

export interface UserOAuthRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  accountId?: string;
  /** Antigravity Cloud Code Assist project id. */
  projectId?: string;
  savedAt: number;
}

export interface PendingPkceSignIn {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface PendingCursorSignIn {
  uuid: string;
  verifier: string;
  createdAt: number;
}
