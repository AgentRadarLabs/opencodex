// Ported from v2.65.0-vadymhimself.27 tests/routing/combo-pool-stale-cooldown.test.ts (4269f45a42); the
// third .27 case exercised the fork-only source-replay gate, which the native lane replaces.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clearComboTargetCooldowns,
  coolComboTarget,
  isComboTargetInCooldown,
  setComboPoolEligibilityProbe,
} from "../../src/combos/failover";

// upstream: the lift is an AgentRadar hosted-gateway rule; off the flag upstream parks a non-pool 429 in full.
const previousHosted = process.env.OPENCODEX_AGENTRADAR;
beforeEach(() => { process.env.OPENCODEX_AGENTRADAR = "1"; });
afterEach(() => {
  setComboPoolEligibilityProbe(undefined);
  clearComboTargetCooldowns();
  if (previousHosted === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previousHosted;
});

const target = { provider: "anthropic", model: "claude-opus-5-5" };

test("a quota cooldown on a pooled target lifts once the pool has an eligible account", () => {
  coolComboTarget("w", target, { retryAfter: "300", status: 429 });
  setComboPoolEligibilityProbe(() => false);
  expect(isComboTargetInCooldown("w", target)).toBe(true);
  setComboPoolEligibilityProbe(provider => provider === "anthropic");
  expect(isComboTargetInCooldown("w", target)).toBe(false);
});

test("a non-quota cooldown is not lifted by pool eligibility", () => {
  coolComboTarget("w", target, { retryAfter: "300", status: 502 });
  setComboPoolEligibilityProbe(() => true);
  expect(isComboTargetInCooldown("w", target)).toBe(true);
});

test("an AgentRadar hosted gateway caps server cooldowns at ten minutes too (d3ea59ccb9)", () => {
  const now = Date.parse("2026-07-18T00:00:00.000Z");
  coolComboTarget("hosted-weekly-retry", target, { now, retryAfter: "318747" });
  expect(isComboTargetInCooldown("hosted-weekly-retry", target, now + 600_000 - 1)).toBe(true);
  expect(isComboTargetInCooldown("hosted-weekly-retry", target, now + 600_000)).toBe(false);
});

test("off the hosted flag a quota cooldown is not lifted by pool eligibility", () => {
  delete process.env.OPENCODEX_AGENTRADAR;
  coolComboTarget("w", target, { retryAfter: "300", status: 429 });
  setComboPoolEligibilityProbe(() => true);
  expect(isComboTargetInCooldown("w", target)).toBe(true);
});
