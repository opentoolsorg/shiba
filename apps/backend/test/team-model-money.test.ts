import { describe, expect, it } from "vitest";
import { formatMicroUsd, parseMicroUsd, teamModelMaximumDebitMicroUsd, teamModelQuotedCostMicroUsd, isTeamModelMoneyContract } from "@shiba/shared";
import { prepareTeamModelMoney, requireTeamModelMoney, teamModelUsageReceipt } from "../src/team-model-money.js";

describe("Money v2 pure reference arithmetic and fixture usage receipts", () => {
  it("reserves the full input context and rounds each neuron-priced component upward", () => {
    expect(teamModelMaximumDebitMicroUsd(1024)).toBe(8341);
    expect(teamModelMaximumDebitMicroUsd(64)).toBe(7956);
    expect(teamModelQuotedCostMicroUsd(1, 1)).toBe(2);
    expect(formatMicroUsd(8341)).toBe("$0.008341");
  });
  it.each(["0", "0.000000", "1.000001", "1.01", "2", "0.0000001", "1e-2", "-0.01", "NaN", " 0.1", "0.1 "])("rejects unsupported or inexact dollar input %s", (value) => {
    expect(parseMicroUsd(value)).toBeNull();
  });
  it("converts a decimal dollar amount without binary-float rounding", () => {
    expect(parseMicroUsd("0.008341")).toBe(8341); expect(parseMicroUsd("1.000000")).toBe(1_000_000);
  });
  it("binds the reference rates, fixed USD scope, per-call envelope and original quote expiry", () => {
    const money = prepareTeamModelMoney(100_000, 1024, 2_000_000, 1_000_000);
    expect(isTeamModelMoneyContract(money, 1024)).toBe(true);
    expect(requireTeamModelMoney(money, 1024, 1_000_001)).toEqual(money);
    expect(() => requireTeamModelMoney(money, 1024, money.quote.dispatchUntil)).toThrow("quote_expired");
    expect(() => requireTeamModelMoney(undefined, 1024)).toThrow("upgrade_required");
    expect(isTeamModelMoneyContract({ ...money, quote: { ...money.quote, inputMicroUsdPerMillionTokens: 60_000 } }, 1024)).toBe(false);
    expect(isTeamModelMoneyContract({ ...money, maximumDebitPerCallMicroUsd: 1 }, 1024)).toBe(false);
    expect(isTeamModelMoneyContract({ ...money, currency: "EUR" }, 1024)).toBe(false);
  });
  it.each([undefined, null, {}, { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
    { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 }, { prompt_tokens: 131_073, completion_tokens: 1, total_tokens: 131_074 },
    { prompt_tokens: 1, completion_tokens: 65, total_tokens: 66 }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 }])("rejects unknown or inconsistent usage without fabricating a charge", async (usage) => {
    await expect(teamModelUsageReceipt({ id: "fixture-response", model: "@cf/zai-org/glm-4.7-flash", usage }, "a".repeat(64), 64)).rejects.toThrow("usage_unknown");
  });
  it("retains exact binding and upward quoted usage as information, not an invoice", async () => {
    const receipt = await teamModelUsageReceipt({ id: "fixture-response", model: "@cf/zai-org/glm-4.7-flash", usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } }, "a".repeat(64), 64);
    expect(receipt.quotedMicroUsd).toBe(6); expect(JSON.parse(receipt.json)).toMatchObject({ inputHash: "a".repeat(64), promptTokens: 32, completionTokens: 8, quotedMicroUsd: 6 });
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
