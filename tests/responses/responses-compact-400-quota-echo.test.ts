/**
 * Compact reads a non-ok body for quota evidence so a quota refusal behind a generic status still
 * cools the pool account. It used to read the body with no status, so a 400 or 422 that only
 * echoed client values ("rate limit", "usage limit", "insufficient_quota") was recorded as a 429
 * and cooled a healthy account. The body is now read with its real status.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, isCodexAccountInCooldown, isCodexAccountSoftAvoided } from "../../src/codex/routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { baseCompactionBody, compactionRequest, twoAccountPoolConfig } from "../helpers/compaction-routing-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;

// The recorded Anthropic 400 (fixtures/external/anthropic/README.md). No recorded validation 400
// that echoes client values exists yet, so the echo bodies are this recorded envelope with only
// `error.message` replaced; envelope keys, `type` and `error.type` stay as recorded.
const RECORDED_LINE = readFileSync(
  join(import.meta.dir, "../../fixtures/external/anthropic/extra-usage-thirdparty-400.txt"),
  "utf8",
);
const RECORDED_BODY = `${RECORDED_LINE.slice("Provider error 400: ".length)}"}}`;
function recordedEnvelopeWithMessage(message: string): string {
  const recorded = JSON.parse(RECORDED_BODY) as { error: Record<string, unknown> };
  return JSON.stringify({ ...recorded, error: { ...recorded.error, message } });
}
const ECHO = recordedEnvelopeWithMessage(
  "input.0.content.0.text: unexpected value: rate limit, too many requests, usage limit reached, toolu_insufficient_quota",
);

async function withPoolEnv(name: string, run: (config: OcxConfig) => Promise<void>): Promise<void> {
  const testDir = mkdtempSync(join(tmpdir(), name));
  const previousOpencodexHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  const releaseSpendHome = acquireOwnedSpendHome();
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
  clearAccountQuota();
  for (const id of ["pool-a", "pool-b"]) {
    saveCodexAccountCredential(id, {
      accessToken: `${id}-access-token`,
      refreshToken: `${id}-refresh-token`,
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: id === "pool-a" ? "pool_acc_a" : "pool_acc_b",
    });
    updateAccountQuota(id, id === "pool-a" ? 10 : 20);
  }
  try {
    await run(twoAccountPoolConfig());
  } finally {
    globalThis.fetch = originalFetch;
    clearCodexUpstreamHealth();
    clearUpstreamHostHealth();
    clearAccountQuota();
    releaseSpendHome();
    removeTreeWithRetry(testDir);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

async function compactAgainst(status: number, body: string, config: OcxConfig) {
  let sends = 0;
  globalThis.fetch = (async () => {
    sends += 1;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const res = await handleResponsesCompact(compactionRequest(baseCompactionBody({})), config, { model: "", provider: "" });
  const accountMarked = isCodexAccountInCooldown("pool-a") || isCodexAccountSoftAvoided("pool-a");
  return { res, sends, accountMarked };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("compact reads a non-ok body for quota with its real status", () => {
  for (const status of [400, 422]) {
    test(`MUST-FAIL: an echoing ${status} does not cool the pool account`, async () => {
      await withPoolEnv(`ocx-compact-echo-${status}-`, async config => {
        const result = await compactAgainst(status, ECHO, config);
        expect(result.res.status).toBe(status);
        expect(result.sends).toBe(1);
        expect(result.accountMarked).toBe(false);
      });
    });
  }

  test("a 400 whose error.code field is insufficient_quota still cools the account", async () => {
    await withPoolEnv("ocx-compact-field-400-", async config => {
      // OpenAI/Codex quota shape: the verdict is the `code` field, not the message words.
      const body = JSON.stringify({ error: { message: "quota", type: "invalid_request_error", code: "insufficient_quota" } });
      const result = await compactAgainst(400, body, config);
      expect(result.accountMarked).toBe(true);
    });
  });

  test("a quota body behind a 5xx still cools the account", async () => {
    await withPoolEnv("ocx-compact-5xx-quota-", async config => {
      const body = JSON.stringify({ error: { message: "The usage limit has been reached", type: "usage_limit_reached" } });
      const result = await compactAgainst(502, body, config);
      expect(result.accountMarked).toBe(true);
    });
  });
});
