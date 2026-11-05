import {
  SHARED_COMPUTER_LIMITS,
  SHARED_COMPUTER_POLICY,
  type SharedComputerSession,
  type SharedComputerState,
} from "@shiba/shared";

/** HTTP/UI fixture only. Never used as a production API fallback. */
export const COMPUTER_FIXTURE_SCOPE = {
  workspaceId: `ws_${"c".repeat(24)}`,
  roomId: `room_${"d".repeat(24)}`,
  actorId: "owner@example.test",
};
export function sharedComputerFixture(): {
  state: SharedComputerState;
  session: SharedComputerSession;
} {
  const session: SharedComputerSession = {
    id: `scs_${"e".repeat(32)}`,
    roomId: COMPUTER_FIXTURE_SCOPE.roomId,
    version: 1,
    digest: "f".repeat(64),
    state: "draft",
    consumed: false,
    contract: {
      policy: SHARED_COMPUTER_POLICY,
      purpose: "offline-human-desktop",
      image: `registry.cloudflare.com/fixture/offline@sha256:${"a".repeat(64)}`,
      roomId: COMPUTER_FIXTURE_SCOPE.roomId,
      ownerId: COMPUTER_FIXTURE_SCOPE.actorId,
      funderId: "operator@example.test",
      viewers: [COMPUTER_FIXTURE_SCOPE.actorId, "viewer@example.test"],
      controllers: [COMPUTER_FIXTURE_SCOPE.actorId],
      expiresAt: Date.now() + 300000,
      maxSessions: 1,
      instance: "standard-1",
      width: 1024,
      height: 768,
      resources: { vcpu: 0.5, memoryMiB: 4096, diskMB: 8000 },
      limits: SHARED_COMPUTER_LIMITS,
      internet: false,
      credentials: null,
      sources: [],
      estimatedContainerOverageUsd: 0.007,
      estimateNotice:
        "Resource estimate only; excludes account base charges, Workers, DO, storage and billing-unit rounding.",
    },
    lease: null,
    nextSequence: 1,
    inputCount: 0,
    frameCount: 0,
    canFund: false,
    canStart: false,
    canControl: false,
    canView: false,
    canStop: true,
    unavailableReason: null,
  };
  return {
    session,
    state: {
      ok: true,
      enabled: true,
      available: true,
      unavailableReason: null,
      ...COMPUTER_FIXTURE_SCOPE,
      sessions: [session],
      members: [
        { userId: COMPUTER_FIXTURE_SCOPE.actorId, version: 1, canFund: false },
        { userId: "operator@example.test", version: 2, canFund: true },
        { userId: "viewer@example.test", version: 3, canFund: false },
      ],
    },
  };
}
