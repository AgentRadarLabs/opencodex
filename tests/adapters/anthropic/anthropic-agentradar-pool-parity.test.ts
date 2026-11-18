// Ported from v2.65.0-vadymhimself.27 anthropic-account-pool.test.ts: AgentRadar hash placement and the
// cached seven-day gate. Assertions are unchanged; only imports and the gateway flag are adapted.
import { rotateAnthropicAccountOn429 } from "../../helpers/anthropic-shared-quota";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState, notePoolRotationFailure, POOL_KEY_ANTHROPIC } from "../../../src/codex/pool-rotation";
import {
  anthropicQuotaWindow,
  anthropicSessionKeyFromParts,
  bindAnthropicSessionAffinity,
  clearAnthropicAccountCooldown,
  clearAnthropicAccountPoolState,
  formatAnthropicProviderForLog,
  getEligibleAnthropicAccounts,
  isAnthropicAccountPoolEnabled,
  normalizeAccountPoolQuotaWindow,
  parseAccountPoolQuotaWindow,
  resolveAnthropicAccountForSession,
  getAnthropicPoolRetryAfterSeconds,
  resetAnthropicRoutingForManualSelection,
  getAnthropicPoolAccessSnapshot,
  promoteAnthropicActiveAccount,
  anthropicSessionAffinitySizeForTests,
} from "../../../src/oauth/anthropic-routing";
import {
  captureOAuthAccountSelection,
  credentialGeneration,
  getAccountCredential,
  getAccountSet,
  markAccountNeedsReauth,
  saveCredential,
  saveAccountCredential,
  setActiveAccount,
} from "../../../src/oauth/store";
import { subscribeAccountSelections } from "../../../src/lib/account-selection-events";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalAgentRadar = process.env.OPENCODEX_AGENTRADAR;
let home: string;

async function admitAnthropic(sessionKey: string, config: OcxConfig) {
  const expected = captureOAuthAccountSelection("anthropic");
  const choice = resolveAnthropicAccountForSession(sessionKey, config);
  if (choice.accountId) {
    const snapshot = await getAnthropicPoolAccessSnapshot(choice.accountId);
    expect(await promoteAnthropicActiveAccount(choice.accountId, expected, {
      config, sessionKey, reason: choice.reason, expectedCredentialGeneration: snapshot.generation,
    })).not.toBeNull();
  }
  return choice;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pool-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_AGENTRADAR = "1";
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (originalAgentRadar === undefined) delete process.env.OPENCODEX_AGENTRADAR;
  else process.env.OPENCODEX_AGENTRADAR = originalAgentRadar;
  removeTreeWithRetry(home);
});

async function seedTwoAccounts() {
  await saveCredential("anthropic", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  // saveCredential activates the newly appended account (B). Pin A as active for predictable tests.
  const { getAccountSet } = await import("../../../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  await setActiveAccount("anthropic", a.id);
  // Ordinary policy cases start after the initial stored selection has been admitted.
  // Restart cases explicitly clear runtime state below to exercise first admission again.
  await admitAnthropic("", cfg(false));
  return { aId: a.id, bId: b.id };
}

function cfg(
  enabled: boolean,
  threshold = 80,
  pool: {
    strategy?: OcxAccountPoolRotationStrategy;
    stickyLimit?: number;
    quotaWindow?: OcxAccountPoolQuotaWindow;
  } = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
    anthropicAccountPool: {
      enabled,
      autoSwitchThreshold: threshold,
      ...pool,
    },
  } as OcxConfig;
}

async function seedThreeAccounts() {
  await saveCredential("anthropic", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-c",
    refresh: "refresh-c",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-cccc",
    email: "c@example.test",
  });
  const { getAccountSet } = await import("../../../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  const c = set.accounts.find(acc => acc.credential.accountId === "uuid-cccc")!;
  await setActiveAccount("anthropic", a.id);
  await admitAnthropic("", cfg(false));
  return { aId: a.id, bId: b.id, cId: c.id };
}


describe("AgentRadar hash placement", () => {
  test("unbound strategy pick does not promote active before token validation", async () => {
    const { aId, bId, cId } = await seedThreeAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    setCachedProviderAccountQuotaForTests("anthropic", cId, { fiveHourPercent: 10 });
    await setActiveAccount("anthropic", aId);
    const config = cfg(true, 80, { strategy: "round-robin", stickyLimit: 1 });

    const before = getAccountSet("anthropic")!.activeAccountId;
    const picks = Array.from({ length: 3 }, (_, i) => resolveAnthropicAccountForSession(`promo-${i}`, config));
    expect(picks.every(p => p.accountId)).toBe(true);
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(before);
  });
  test("429 failover never returns null while any eligible account remains", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // B is known spent for the week with its reset still ahead, so it is not eligible (was: still returned).
    setCachedProviderAccountQuotaForTests("anthropic", bId, {
      fiveHourPercent: 100,
      weeklyPercent: 100,
      weeklyResetAt: Date.now() + 2 * 86_400_000,
      updatedAt: Date.now(),
    });

    expect(rotateAnthropicAccountOn429(cfg(true, 80, { quotaWindow: "weekly" }), aId, "30", "weekly-never-null")).toBeNull();
  });
  test("round-robin keyed sessions take a stable hash seat; a 429 unbinds only the hitting session", async () => {
    await seedThreeAccounts();
    const config = cfg(true, 80, { strategy: "round-robin" });
    const seats = () => Array.from({ length: 60 }, (_, i) => resolveAnthropicAccountForSession(`s${i}`, config).accountId);

    const first = seats();
    expect(new Set(first).size).toBe(3);
    // A fresh process: empty affinity, cooldowns and round-robin ring (its stored selection admitted first).
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    await admitAnthropic("", cfg(false));
    expect(seats()).toEqual(first);

    const seat = first[0]!;
    const bystander = `s${first.indexOf(seat, 1)}`;
    bindAnthropicSessionAffinity("s0", seat);
    bindAnthropicSessionAffinity(bystander, seat);
    const next = rotateAnthropicAccountOn429(config, seat, "60", "s0");
    // .27 kept bystander bindings (size 1); upstream's durable affinity invalidates every binding on a
    // spent account. Hash placement precedes affinity, so the observable seats below are unchanged.
    expect(next).toBeTruthy();
    expect(next).not.toBe(seat);
    // The cooled hash seat fails over to the session's runner-up, and the bystander moves off it too.
    expect(resolveAnthropicAccountForSession("s0", config)).toEqual({ accountId: next, reason: "hash" });
    expect(resolveAnthropicAccountForSession(bystander, config).accountId).not.toBe(seat);
  });

  test("a hashed session moves off a spent seat to its runner-up and returns on recovery", async () => {
    await seedThreeAccounts();
    const config = cfg(true, 80, { strategy: "round-robin" });
    const seat = resolveAnthropicAccountForSession("s0", config).accountId!;
    bindAnthropicSessionAffinity("s0", seat);

    // Five-hour window spent: the session fails over to its hash runner-up and stays there.
    const spent = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(Math.ceil(Date.now() / 1000) + 3600),
    });
    const next = rotateAnthropicAccountOn429(config, seat, null, "s0", Date.now(), spent)!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(seat);
    bindAnthropicSessionAffinity("s0", next);
    expect(resolveAnthropicAccountForSession("s0", config)).toEqual({ accountId: next, reason: "affinity" });
    // A fresh process does not know the seat is spent: its first 429 lands on the same runner-up.
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    await admitAnthropic("", cfg(false));
    expect(resolveAnthropicAccountForSession("s0", config).accountId).toBe(seat);
    expect(rotateAnthropicAccountOn429(config, seat, null, "s0", Date.now(), spent)).toBe(next);
    bindAnthropicSessionAffinity("s0", next);
    // Recovery: this warm process returns the session to its seat, as a fresh one would.
    clearAnthropicAccountCooldown(seat);
    expect(resolveAnthropicAccountForSession("s0", config)).toEqual({ accountId: seat, reason: "hash" });
  });

  test("the store's startup selection does not seat a keyed round-robin session", async () => {
    const { aId } = await seedThreeAccounts();
    const config = cfg(true, 80, { strategy: "round-robin" });
    // A fresh process whose stored selection (with a revision) is A: a key hashed elsewhere keeps its seat.
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    expect(getAccountSet("anthropic")!.selectionRevision).toBeDefined();
    let key = "";
    for (let i = 0; !key && i < 50; i++) {
      clearAnthropicAccountPoolState();
      const pick = resolveAnthropicAccountForSession(`fresh-${i}`, cfg(true, 80, { strategy: "quota" }));
      expect(pick).toEqual({ accountId: aId, reason: "manual" });
      clearAnthropicAccountPoolState();
      const seat = resolveAnthropicAccountForSession(`fresh-${i}`, config);
      if (seat.accountId !== aId) {
        expect(seat.reason).toBe("hash");
        key = `fresh-${i}`;
      }
    }
    expect(key).not.toBe("");
    // A pick made in this process still wins its one dispatch.
    resetAnthropicRoutingForManualSelection(aId);
    expect(resolveAnthropicAccountForSession(key, config)).toEqual({ accountId: aId, reason: "manual" });
  });

});

describe("weekly-spent accounts across fresh instances", () => {
  const rrConfig = () => cfg(true, 80, { strategy: "round-robin" });
  const dayAhead = () => Date.now() + 86_400_000;
  /** What a new instance looks like: no cooldowns, affinity or ring, the stored selection admitted first. */
  async function freshInstance() {
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    await admitAnthropic("", cfg(false));
  }

  test("a fresh instance never picks an account whose weekly window is spent (hash, affinity, active)", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Admit the stored selection first: the gate (rightly) refuses to promote an account already known spent.
    await freshInstance();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { weeklyPercent: 100, weeklyResetAt: dayAhead(), updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 20, weeklyResetAt: dayAhead(), updatedAt: Date.now() });

    // Hash seats: without the gate about half of these keys land on A.
    for (let i = 0; i < 40; i++) expect(resolveAnthropicAccountForSession(`s${i}`, rrConfig()).accountId).toBe(bId);
    // Affinity bound to A (as a previous request in this process could have) is dropped, not honoured.
    bindAnthropicSessionAffinity("bound", aId);
    expect(resolveAnthropicAccountForSession("bound", cfg(true, 80)).accountId).toBe(bId);
    // The stored active account is A: an unkeyed request must not stay on it.
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(aId);
    expect(resolveAnthropicAccountForSession(null, rrConfig()).accountId).toBe(bId);
  });

  test("a seven-day 429 with the only other account known spent surfaces the 429 with the earliest weekly reset", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const now = Date.now();
    const aReset = now + 2 * 86_400_000;
    setCachedProviderAccountQuotaForTests("anthropic", aId, { weeklyPercent: 100, weeklyResetAt: aReset, updatedAt: now });
    const bResetSec = Math.ceil(now / 1000) + 3_600;
    const rejected = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-reset": String(bResetSec),
    });

    expect(rotateAnthropicAccountOn429(rrConfig(), bId, null, "k", now, rejected)).toBeNull();
    expect(getEligibleAnthropicAccounts(now)).toEqual([]);
    expect(getAnthropicPoolRetryAfterSeconds(now)).toBe(Math.ceil((bResetSec * 1000 - now) / 1000));
  });

  test("Retry-After follows the earliest weekly reset when no cooldown is recorded", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const now = Date.now();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { weeklyPercent: 100, weeklyResetAt: now + 5_000_000, updatedAt: now });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 100, weeklyResetAt: now + 9_000_000, updatedAt: now });
    expect(getAnthropicPoolRetryAfterSeconds(now)).toBe(5_000);
    expect(resolveAnthropicAccountForSession("k", rrConfig(), now)).toEqual({ accountId: null, reason: "all-cooled" });
  });
});
