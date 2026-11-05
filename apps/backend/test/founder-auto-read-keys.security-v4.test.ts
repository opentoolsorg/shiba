import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { googleRuntimeFingerprint, scopedGoogleReadToken, verifiedGoogleReadToken } from "../src/founder-auto-read-keys.js";

const workspace = `ws_${"a".repeat(24)}`;
const other = `ws_${"b".repeat(24)}`;
const token = `oct_${"a".repeat(43)}`;
const replacement = `oct_${"b".repeat(43)}`;
const entry = (workspaceId = workspace, connectionId = "source-one", value = token) => ({ workspaceId, connectionId, operationId: "googleads.campaign_daily_metrics", token: value });
const env = (raw: string) => ({ INTERNAL_SIGNING_KEY: "independent-fixture-signing-key-123456789", OPEN_CONNECTOR_READ_RUNTIME_TOKEN: replacement, OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS: raw }) as unknown as Env;

describe("independent v4 per-source key boundaries", () => {
  it("rejects duplicate JSON property spellings including escaped names", () => {
    for (const duplicate of ['"workspaceId"', '"workspace\\u0049d"']) {
      const raw = `[{"workspaceId":"${other}",${duplicate}:"${workspace}","connectionId":"source-one","operationId":"googleads.campaign_daily_metrics","token":"${token}"}]`;
      expect(() => scopedGoogleReadToken(env(raw), workspace, "source-one")).toThrow();
    }
  });
  it("does not let an invalid duplicate disappear while an unrelated valid tenant works", () => {
    const e = env(JSON.stringify([entry(), { ...entry(), token: 1 }, entry(other, "source-one", replacement), null]));
    expect(() => scopedGoogleReadToken(e, workspace, "source-one")).toThrow();
    expect(scopedGoogleReadToken(e, other, "source-one")).toBe(replacement);
    expect(() => scopedGoogleReadToken(e, workspace, "missing")).toThrow();
  });
  it("rejects duplicate keys when the earlier value is not a JSON string", () => {
    for (const prior of ["null", "123", "true", "{}", "[]"]) {
      const raw = `[{"workspaceId":${prior},"workspaceId":"${workspace}","connectionId":"source-one","operationId":"googleads.campaign_daily_metrics","token":"${token}"}]`;
      expect(() => scopedGoogleReadToken(env(raw), workspace, "source-one")).toThrow();
    }
  });
  it("does not accept another tenant's or another source's valid key pin", async () => {
    const e = env(JSON.stringify([entry(), entry(other), entry(workspace, "source-two")]));
    const pin = await googleRuntimeFingerprint(e, workspace, "source-one", token);
    expect(await verifiedGoogleReadToken(e, workspace, "source-one", pin)).toBe(token);
    await expect(verifiedGoogleReadToken(e, other, "source-one", pin)).rejects.toThrow();
    await expect(verifiedGoogleReadToken(e, workspace, "source-two", pin)).rejects.toThrow();
    Object.assign(e, { OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS: JSON.stringify([entry(workspace, "source-one", replacement)]) });
    await expect(verifiedGoogleReadToken(e, workspace, "source-one", pin)).rejects.toThrow();
  });
});
