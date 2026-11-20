import { describe, expect, test } from "bun:test";
import { parseClaudeUsageCredits } from "../../src/providers/quota/anthropic-usage-windows";
import { claudeCreditsText } from "../../src/cli/account-key-quota";

// Shapes captured from the live OAuth usage endpoint (2026-11-20), identities removed.
const spend = (over: Record<string, unknown> = {}) => ({
  used: { amount_minor: 1730, currency: "USD", exponent: 2 },
  limit: { amount_minor: 10000, currency: "USD", exponent: 2 },
  balance: null, enabled: false, disabled_reason: "out_of_credits", ...over,
});

describe("Claude usage credits", () => {
  test("reads spent, cap and reason from the spend row in major units", () => {
    expect(parseClaudeUsageCredits({ spend: spend() }))
      .toEqual({ currency: "USD", used: 17.3, limit: 100, enabled: false, disabledReason: "out_of_credits" });
  });

  test("reports a prepaid balance when Anthropic sends one", () => {
    expect(parseClaudeUsageCredits({ spend: spend({ enabled: true, disabled_reason: null, balance: { amount_minor: 2550, exponent: 2 } }) }))
      .toEqual({ currency: "USD", used: 17.3, limit: 100, balance: 25.5, enabled: true });
  });

  test("falls back to extra_usage when spend is absent", () => {
    expect(parseClaudeUsageCredits({ extra_usage: { is_enabled: false, monthly_limit: 4000, used_credits: 0, currency: "USD", decimal_places: 2, disabled_reason: "out_of_credits" } }))
      .toEqual({ currency: "USD", used: 0, limit: 40, enabled: false, disabledReason: "out_of_credits" });
  });

  test("omits the cap when there is none and rejects malformed rows", () => {
    expect(parseClaudeUsageCredits({ spend: spend({ limit: null, disabled_reason: null }) }))
      .toEqual({ currency: "USD", used: 17.3, enabled: false });
    expect(parseClaudeUsageCredits({ extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, currency: null } })).toBeUndefined();
    expect(parseClaudeUsageCredits({ spend: { enabled: true, used: { amount_minor: "x", currency: "USD", exponent: 2 } } })).toBeUndefined();
    expect(parseClaudeUsageCredits({ spend: spend({ disabled_reason: "Bad\nReason" }) })?.disabledReason).toBeUndefined();
  });

  test("the usage probe carries credits next to the plan windows", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" },
      seven_day: { utilization: 40, resets_at: "2099-01-02T00:00:00Z" },
      spend: spend(),
    })) as unknown as typeof fetch;
    try {
      const { probeAnthropicUsageQuota } = await import("../../src/providers/claude-cli-usage");
      const { quota } = await probeAnthropicUsageQuota("synthetic-token");
      expect(quota?.weeklyPercent).toBe(40);
      expect(quota?.claudeUsageCredits).toEqual({ currency: "USD", used: 17.3, limit: 100, enabled: false, disabledReason: "out_of_credits" });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("renders a one-line summary for the account table", () => {
    expect(claudeCreditsText({ currency: "USD", used: 17.3, limit: 100, enabled: false, disabledReason: "out_of_credits" }))
      .toBe("credits $17.30 of $100.00 off (out_of_credits)");
    expect(claudeCreditsText({ currency: "USD", used: 0, balance: 25.5, enabled: true })).toBe("credits $0.00 balance $25.50 on");
    expect(claudeCreditsText({ currency: "usd", used: 1, enabled: true })).toBe("");
    expect(claudeCreditsText(undefined)).toBe("");
  });
});
