import { isTrustedSender } from "./navigation.js";

export type SessionPermissionMediaDetails = {
  mediaTypes?: readonly string[];
  mediaType?: string;
};

/** Maps Electron permission handler `details` to the policy input. */
export function mediaDetailsFromHandler(
  permission: string,
  details?: unknown,
): SessionPermissionMediaDetails | undefined {
  if (permission !== "media" || !details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const mediaTypes = record.mediaTypes;
  const mediaType = record.mediaType;
  return {
    mediaTypes: Array.isArray(mediaTypes) ? mediaTypes.map(String) : undefined,
    mediaType: typeof mediaType === "string" ? mediaType : undefined,
  };
}

function mediaKinds(details?: SessionPermissionMediaDetails): readonly string[] {
  if (details?.mediaTypes && details.mediaTypes.length > 0) return details.mediaTypes;
  if (details?.mediaType && details.mediaType !== "unknown") return [details.mediaType];
  return [];
}

function allowsTrustedAudioOnly(
  permission: string,
  requestUrl: string,
  configuredOrigin: string,
  details?: SessionPermissionMediaDetails,
): boolean {
  if (!isTrustedSender(requestUrl, configuredOrigin)) return false;
  if (permission !== "media") return false;
  const kinds = mediaKinds(details);
  if (kinds.length === 0) return false;
  if (kinds.includes("video")) return false;
  return kinds.includes("audio");
}

/** Chromium session permission policy for the Shiba shell window. */
export function shouldAllowSessionPermission(
  permission: string,
  requestUrl: string,
  configuredOrigin: string,
  details?: SessionPermissionMediaDetails,
): boolean {
  if (permission === "clipboard-sanitized-write") {
    return isTrustedSender(requestUrl, configuredOrigin);
  }
  if (permission === "media") {
    return allowsTrustedAudioOnly(permission, requestUrl, configuredOrigin, details);
  }
  return false;
}