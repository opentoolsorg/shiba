import { describe, expect, it } from "vitest";
import {
  appendDodoCheckoutAttribution,
  mergeMinilyticsIntoMetadata,
  minilyticsAttributionFromRequest,
  parseMinilyticsCookies,
} from "@shiba/shared";

describe("minilytics attribution", () => {
  it("parses ml_vid and ml_sid from Cookie header", () => {
    expect(
      parseMinilyticsCookies("session=abc; ml_vid=visitor-1; other=x; ml_sid=session-9"),
    ).toEqual({ ml_visitor_id: "visitor-1", ml_session_id: "session-9" });
  });

  it("merges into metadata without dropping existing keys", () => {
    expect(
      mergeMinilyticsIntoMetadata(
        { plan: "pro", ml_visitor_id: "keep" },
        { ml_session_id: "sid" },
      ),
    ).toEqual({ plan: "pro", ml_visitor_id: "keep", ml_session_id: "sid" });
  });

  it("reads cookies from Request and defaults empty strings", () => {
    const request = new Request("https://tryshiba.dev/api/checkout", {
      headers: { Cookie: "ml_vid=v1" },
    });
    expect(mergeMinilyticsIntoMetadata({}, minilyticsAttributionFromRequest(request))).toEqual({
      ml_visitor_id: "v1",
      ml_session_id: "",
    });
  });

  it("appends Dodo checkout metadata query params", () => {
    expect(
      appendDodoCheckoutAttribution("https://checkout.dodopayments.com/buy/p_abc", {
        ml_visitor_id: "v",
        ml_session_id: "s",
      }),
    ).toBe("https://checkout.dodopayments.com/buy/p_abc?metadata_ml_visitor_id=v&metadata_ml_session_id=s");
  });
});
