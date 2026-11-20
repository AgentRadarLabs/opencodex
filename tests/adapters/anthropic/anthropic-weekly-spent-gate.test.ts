// Ported from v2.65.0-vadymhimself.27 (c49bb29146), cached gate only: an AgentRadar process with an
// empty cooldown map must not seat a session on an account whose seven-day window is known spent.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import {
  anthropicPoolCooldownError, bindAnthropicSessionAffinity, clearAnthropicAccountPoolState,
  getEligibleAnthropicAccounts, recordAnthropicAccountRefusal, resolveAnthropicAccountForSession,
} from "../../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalFlag = process.env.OPENCODEX_AGENTRADAR;
let home: string;
const config = (strategy: "round-robin" | "quota" = "round-robin") => ({
  providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } },
  anthropicAccountPool: { enabled: true, strategy, autoSwitchThreshold: 80 },
}) as unknown as OcxConfig;
const dayAhead = () => Date.now() + 86_400_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-weekly-gate-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_AGENTRADAR = "1";
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache("anthropic");
});
afterEach(() => {
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache("anthropic");
  if (originalFlag === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = originalFlag;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

async function seed() {
  for (const id of ["a", "b"]) await saveCredential("anthropic", { access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000, accountId: `uuid-${id}` });
  const accounts = getAccountSet("anthropic")!.accounts;
  const aId = accounts.find(account => account.credential.accountId === "uuid-a")!.id;
  const bId = accounts.find(account => account.credential.accountId === "uuid-b")!.id;
  await setActiveAccount("anthropic", aId);
  return { aId, bId };
}

test("hash seats, restored affinity and the stored active account all skip a weekly-spent account", async () => {
  const { aId, bId } = await seed();
  setCachedProviderAccountQuotaForTests("anthropic", aId, { weeklyPercent: 100, weeklyResetAt: dayAhead(), updatedAt: Date.now() });
  setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 20, weeklyResetAt: dayAhead(), updatedAt: Date.now() });
  for (let i = 0; i < 40; i++) expect(resolveAnthropicAccountForSession(`s${i}`, config()).accountId).toBe(bId);
  bindAnthropicSessionAffinity("bound", aId);
  expect(resolveAnthropicAccountForSession("bound", config("quota")).accountId).toBe(bId);
  expect(resolveAnthropicAccountForSession(null, config()).accountId).toBe(bId);
});

test("an all-spent pool refuses locally with the earliest weekly reset instead of sending", async () => {
  const { aId, bId } = await seed();
  const aReset = dayAhead() + 86_400_000, bReset = dayAhead();
  setCachedProviderAccountQuotaForTests("anthropic", aId, { weeklyPercent: 100, weeklyResetAt: aReset, updatedAt: Date.now() });
  setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 100, weeklyResetAt: bReset, updatedAt: Date.now() });
  expect(getEligibleAnthropicAccounts()).toEqual([]);
  expect(resolveAnthropicAccountForSession("s", config())).toMatchObject({ accountId: null, reason: "all-cooled" });
  expect(anthropicPoolCooldownError().usageLimit).toEqual({ resetsAt: bReset });
});

test("a reading without a future reset fails open, and ordinary installs keep the soft preference", async () => {
  const { aId, bId } = await seed();
  setCachedProviderAccountQuotaForTests("anthropic", aId, { weeklyPercent: 100, updatedAt: Date.now() });
  setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 100, weeklyResetAt: Date.now() - 1_000, updatedAt: Date.now() });
  expect(getEligibleAnthropicAccounts().sort()).toEqual([aId, bId].sort());
  setCachedProviderAccountQuotaForTests("anthropic", bId, { weeklyPercent: 100, weeklyResetAt: dayAhead(), updatedAt: Date.now() });
  delete process.env.OPENCODEX_AGENTRADAR;
  expect(getEligibleAnthropicAccounts().sort()).toEqual([aId, bId].sort());
});

test("a rejected seven-day refusal persists the spent window, so a fresh process skips the account", async () => {
  const { aId, bId } = await seed();
  const resetSeconds = Math.ceil(dayAhead() / 1000);
  expect(recordAnthropicAccountRefusal(config(), aId, 429, null, Date.now(), new Headers({
    "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(resetSeconds) }))).toBe(true);
  expect(getCachedProviderAccountQuota("anthropic", aId)).toMatchObject({ weeklyPercent: 100, weeklyResetAt: resetSeconds * 1000 });
  clearAnthropicAccountPoolState(); // the per-process cooldown is gone; the quota cache remains
  expect(getEligibleAnthropicAccounts()).toEqual([bId]);
});
