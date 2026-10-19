/**
 * ChatGPT plan app-server session — restart on token renewal, thread/resume.
 */
export interface PlanSessionState {
  accessToken: string;
  expiresAt: number;
  threadId: string | null;
  serverGeneration: number;
}

export function shouldRestartAppServer(state: PlanSessionState, next: { accessToken: string; expiresAt: number }): boolean {
  return next.accessToken !== state.accessToken || next.expiresAt > state.expiresAt;
}

export function applyTokenRenewal(
  state: PlanSessionState,
  next: { accessToken: string; expiresAt: number },
): PlanSessionState {
  if (!shouldRestartAppServer(state, next)) return state;
  return {
    ...state,
    accessToken: next.accessToken,
    expiresAt: next.expiresAt,
    serverGeneration: state.serverGeneration + 1,
  };
}

export function resumeThreadAfterRestart(state: PlanSessionState, threadId: string): PlanSessionState {
  return { ...state, threadId, serverGeneration: state.serverGeneration };
}
