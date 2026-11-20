// Parity with v2.65.0-vadymhimself.27 anthropic-ratelimit-headers "a model-scoped weekly 429 cools only that
// model family": a unified refusal whose representative claim is seven_day_<family> spends that family alone.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { bindAnthropicRefusalCredential, rotateAnthropicAccountOnResponse } from "../../../src/oauth/anthropic-account-refusal";
import {
  anthropicPoolCooldownError, clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot,
  getAnthropicPoolAccessSnapshot, getEligibleAnthropicAccounts, resolveAnthropicAccountForSession,
} from "../../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import { clearAccountQuotaCache } from "../../../src/providers/quota";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
const config = { providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } }, anthropicAccountPool: { enabled: true } } as unknown as OcxConfig;
const opusWeekly = (reset: number) => new Headers({
  "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
  "anthropic-ratelimit-unified-reset": String(reset), "anthropic-ratelimit-unified-5h-status": "allowed", "anthropic-ratelimit-unified-7d-status": "allowed",
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-family-claim-")); process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache("anthropic");
});
afterEach(() => {
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache("anthropic");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function refuse(accountId: string, headers: Headers, model: string) {
  const response = new Response(null, { status: 429, headers });
  bindAnthropicRefusalCredential(response, await getAnthropicPoolAccessSnapshot(accountId));
  return rotateAnthropicAccountOnResponse(response, { config, accountId, model, canRetry: true, requestKey: {} });
}

test("Opus cools per account, Sonnet keeps the account, and an all-Opus-spent pool answers a usage limit", async () => {
  for (const i of [0, 1]) await saveCredential("anthropic", { access: `access-${i}`, refresh: `refresh-${i}`, expires: Date.now() + 3_600_000, accountId: `uuid-${i}` });
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  const reset = Math.floor(Date.now() / 1000) + 3 * 86_400;
  expect(await refuse(ids[0]!, opusWeekly(reset), "claude-opus-5")).toBe(ids[1]!);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!)).toBeNull();
  expect(getEligibleAnthropicAccounts(Date.now(), "claude-opus-5")).toEqual([ids[1]!]);
  expect(getEligibleAnthropicAccounts(Date.now(), "claude-sonnet-5-5")).toEqual(ids);

  await refuse(ids[1]!, opusWeekly(reset), "claude-opus-5");
  expect(resolveAnthropicAccountForSession("s3", config, Date.now(), null, "claude-opus-5").reason).toBe("all-cooled");
  expect(anthropicPoolCooldownError(Date.now(), null, "claude-opus-5").usageLimit).toEqual({ resetsAt: reset * 1000 });
  expect(resolveAnthropicAccountForSession("s4", config, Date.now(), null, "claude-sonnet-5-5").accountId).not.toBeNull();
});

test("the claim counts only for its own family: a Sonnet request on an Opus claim is shared quota", async () => {
  for (const i of [0, 1]) await saveCredential("anthropic", { access: `access-${i}`, refresh: `refresh-${i}`, expires: Date.now() + 3_600_000, accountId: `uuid-${i}` });
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  expect(await refuse(ids[0]!, opusWeekly(Math.floor(Date.now() / 1000) + 3_600), "claude-sonnet-5-5")).toBe(ids[1]!);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!)).not.toBeNull();
});
