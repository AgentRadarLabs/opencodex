// Parity with v2.65.0-vadymhimself.27 anthropic-ratelimit-headers: on an AgentRadar gateway a 429 with no
// unified status cools its account and rotates; an allowed unified status fails over without cooling.
// Driven through the refusal path a request takes (rotateAnthropicAccountOnResponse); .27's log text is not ported.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { bindAnthropicRefusalCredential, rotateAnthropicAccountOnResponse } from "../../../src/oauth/anthropic-account-refusal";
import { clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot, getAnthropicPoolAccessSnapshot, getEligibleAnthropicAccounts } from "../../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import { clearAccountQuotaCache } from "../../../src/providers/quota";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalFlag = process.env.OPENCODEX_AGENTRADAR;
let home: string;
const config = { providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } }, anthropicAccountPool: { enabled: true } } as unknown as OcxConfig;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ar-429-")); process.env.OPENCODEX_HOME = home; process.env.OPENCODEX_AGENTRADAR = "1";
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache("anthropic");
});
afterEach(() => {
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache("anthropic");
  if (originalFlag === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = originalFlag;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function seed() {
  for (const i of [0, 1]) await saveCredential("anthropic", { access: `access-${i}`, refresh: `refresh-${i}`, expires: Date.now() + 3_600_000, accountId: `uuid-${i}` });
  return getAccountSet("anthropic")!.accounts.map(account => account.id);
}
async function refuse(accountId: string, headers: Record<string, string>, model = "claude-opus-5") {
  const response = new Response(null, { status: 429, headers });
  bindAnthropicRefusalCredential(response, await getAnthropicPoolAccessSnapshot(accountId));
  return rotateAnthropicAccountOnResponse(response, { config, accountId, model, canRetry: true, requestKey: {} });
}

test("an allowed unified status fails the request over without cooling either account, while a header-less 429 still cools", async () => {
  const ids = await seed();
  const allowed = { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-5h-status": "allowed", "anthropic-ratelimit-unified-7d-status": "allowed" };
  expect(await refuse(ids[0]!, allowed)).toBe(ids[1]!);
  expect(ids.map(id => getAnthropicAccountHealthSnapshot(id))).toEqual([null, null]);
  clearAnthropicAccountPoolState();
  const start = Date.now();
  expect(await refuse(ids[0]!, {})).toBe(ids[1]!);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!)?.cooldownUntil).toBeGreaterThanOrEqual(start + 60_000);
});

test("a five-hour claim on an Opus request still cools the whole account", async () => {
  const ids = await seed();
  const start = Date.now();
  expect(await refuse(ids[0]!, { "retry-after": "120", "anthropic-ratelimit-unified-representative-claim": "five_hour" })).toBe(ids[1]!);
  const until = getAnthropicAccountHealthSnapshot(ids[0]!)?.cooldownUntil ?? 0;
  expect(until).toBeGreaterThanOrEqual(start + 120_000);
  expect(until).toBeLessThanOrEqual(Date.now() + 120_000);
  expect(getEligibleAnthropicAccounts(Date.now(), "claude-sonnet-5-5")).toEqual([ids[1]!]);
});

test("ordinary installs keep upstream's request-local header-less 429", async () => {
  delete process.env.OPENCODEX_AGENTRADAR;
  const ids = await seed();
  await refuse(ids[0]!, {});
  expect(getAnthropicAccountHealthSnapshot(ids[0]!)).toBeNull();
});
