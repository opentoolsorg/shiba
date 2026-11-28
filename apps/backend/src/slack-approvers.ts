/**
 * The Slack approver allowlist: the people allowed to approve a run, and the
 * people allowed to release a reviewed reply to a channel shared outside the
 * workspace. Empty or unset means nobody — never "anyone in the channel".
 */
export function parseApproverAllowlist(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Exact user-id membership. No prefix/channel/role matching. */
export function isApprover(userId: string, allowlist: string[]): boolean {
  return userId !== "" && allowlist.includes(userId);
}
