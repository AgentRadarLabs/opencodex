import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { STORE_BUDGET_MS } from "../helpers/test-budget";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  currentUsageLogRevision,
  encodePersistedRequestedModel,
  normalizeUsageEntryForTest,
  normalizeClaudeCompatibilityUsageLog,
  normalizePersistedUsageRow,
  physicalUsageAttempts,
  readRecentUsageEntries,
  readUsageEntries,
  readUsageEntriesForManagement,
  readUsageSnapshotForManagement,
  resetUsageReadCacheForTests,
  usageForFinalLog,
  usageLogPath,
  usageStatusForFinalLog,
  usageTotalTokens,
  usageReadCacheStatsForTests,
  usageLogRevisionKey,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("usage log", () => {








  test("preserves only literal-true combo target advances", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-combo-target-advance",
      timestamp: 1,
      provider: "combo",
      model: "combo/test",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
      comboTargetAdvanced: true,
    };

    expect(normalizeUsageEntryForTest(entry).comboTargetAdvanced).toBe(true);
    expect(normalizeUsageEntryForTest({
      ...entry,
      comboTargetAdvanced: false,
    } as unknown as PersistedUsageEntry).comboTargetAdvanced).toBeUndefined();
  });


  test("preserves only valid physical send time and prompt-cache TTL metadata", () => {
    const base = {
      requestId: "ocx-physical-order",
      timestamp: 1,
      provider: "anthropic-pabc123",
      model: "claude-opus-5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported" as const,
      attempts: [{
        ordinal: 1,
        provider: "anthropic-pabc123",
        model: "claude-opus-5",
        adapter: "anthropic",
        status: 200,
        durationMs: 1,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported" as const,
        firstSendAt: 123.25,
        promptCacheTtlMs: 3_600_000,
      }],
    };

    const normalized = normalizeUsageEntryForTest(base as unknown as PersistedUsageEntry);
    expect(normalized.attempts?.[0]).toMatchObject({
      firstSendAt: 123.25,
      promptCacheTtlMs: 3_600_000,
    });

    const rejected = normalizeUsageEntryForTest({
      ...base,
      attempts: [{
        ...base.attempts[0],
        firstSendAt: -1,
        promptCacheTtlMs: Number.NaN,
      }],
    } as unknown as PersistedUsageEntry);
    expect(rejected.attempts?.[0]?.firstSendAt).toBeUndefined();
    expect(rejected.attempts?.[0]?.promptCacheTtlMs).toBeUndefined();
  });





  /** Build one minimal persisted-usage JSONL line for the given request id. */
  const persistedLine = (requestId: string) => JSON.stringify({
    requestId,
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
  });








  test("persists server-tool counters on parent and attempt usage", () => {
    appendUsageEntry({
      requestId: "ocx-server-tools",
      timestamp: 1,
      provider: "anthropic",
      model: "claude-opus-5",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: {
        inputTokens: 20,
        outputTokens: 2,
        anthropicServerToolUse: { web_search_requests: 3, web_fetch_requests: 1 },
      },
      attempts: [{
        ordinal: 1,
        provider: "anthropic",
        model: "claude-opus-5",
        adapter: "anthropic",
        status: 200,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: {
          inputTokens: 20,
          outputTokens: 2,
          anthropicServerToolUse: { web_search_requests: 3, web_fetch_requests: 1 },
        },
      }],
    });

    expect(readUsageEntries()[0]).toMatchObject({
      usage: {
        anthropicServerToolUse: { web_search_requests: 3, web_fetch_requests: 1 },
      },
      attempts: [{
        usage: {
          anthropicServerToolUse: { web_search_requests: 3, web_fetch_requests: 1 },
        },
      }],
    });
  });

  test("bounds and sanitizes persisted server-tool counter maps", () => {
    const counters = Object.fromEntries([
      ["web_search_requests", 2],
      ["negative", -1],
      ["not_finite", Number.POSITIVE_INFINITY],
      ["__proto__", 1],
      ["x".repeat(200), 1],
      ...Array.from({ length: 200 }, (_, index) => [`tool_${index}`, index]),
    ]);
    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-server-tool-bounds",
      timestamp: 1,
      provider: "anthropic",
      model: "claude-opus-5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        anthropicServerToolUse: counters,
      },
    });
    const persisted = normalized.usage?.anthropicServerToolUse;

    expect(persisted?.web_search_requests).toBe(2);
    expect(persisted).not.toHaveProperty("negative");
    expect(persisted).not.toHaveProperty("not_finite");
    expect(Object.prototype.hasOwnProperty.call(persisted, "__proto__")).toBe(false);
    expect(persisted).not.toHaveProperty("x".repeat(200));
    expect(Object.keys(persisted ?? {}).length).toBeLessThan(200);
  });







  test("keeps physical identity when optional attempt telemetry is malformed", () => {
    const valid = {
      ordinal: 1,
      provider: "anthropic",
      model: "claude-opus-5",
      adapter: "anthropic",
      status: 200,
      durationMs: 1,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported",
      usage: { inputTokens: 2, outputTokens: 1 },
      totalTokens: 3,
    };
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["inputTokenEstimate", { ...valid, inputTokenEstimate: -1 }],
      ["totalTokens", { ...valid, totalTokens: -1 }],
      ["firstOutputMs", { ...valid, firstOutputMs: -1 }],
      ["firstOutputMs", { ...valid, firstOutputMs: null }],
      ["firstOutputMs", { ...valid, firstOutputMs: "3" }],
      ["recoveryCount", { ...valid, recoveryCount: -1 }],
      ["usage", { ...valid, usage: { inputTokens: "2", outputTokens: 1 } }],
      ["usage", { ...valid, usage: { inputTokens: 2, outputTokens: "1" } }],
    ];

    for (const [field, rawAttempt] of malformed) {
      const normalized = normalizeUsageEntryForTest({
        requestId: `optional-${field}`,
        timestamp: 1,
        provider: "combo",
        model: "combo/free",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        attempts: [rawAttempt as unknown as typeof valid],
      });
      expect(normalized.attempts).toHaveLength(1);
      expect(normalized.attempts?.[0]).toMatchObject({
        ordinal: 1,
        provider: "anthropic",
        model: "claude-opus-5",
        status: 200,
      });
      expect(normalized.attempts?.[0]).not.toHaveProperty(field);
    }
  });

  test("retains nonphysical duplicate ordinals until physical filtering", () => {
    const physical = {
      ordinal: 1,
      provider: "anthropic",
      model: "claude-opus-5",
      adapter: "anthropic",
      status: 200,
      durationMs: 2,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      usage: { inputTokens: 10, outputTokens: 2 },
      totalTokens: 12,
    };

    for (const diagnostic of [
      { ...physical, provider: "local", locallyAnswered: true },
      { ...physical, provider: "unsent", sendCount: 0 },
    ]) {
      const normalized = normalizeUsageEntryForTest({
        requestId: `duplicate-${diagnostic.provider}`,
        timestamp: 1,
        provider: "combo",
        model: "combo/free",
        status: 200,
        durationMs: 3,
        usageStatus: "reported",
        attempts: [diagnostic, physical],
      });

      expect(normalized.attempts?.map(attempt => attempt.provider)).toEqual([
        diagnostic.provider,
        physical.provider,
      ]);
      expect(physicalUsageAttempts(normalized.attempts ?? [])).toEqual([physical]);
    }
  });











  // A turn the proxy answered locally issued no upstream request, so its zero counts are exact.
  // The provider-wide estimated marking exists because the Kiro/Cursor adapters can only guess a
  // real inference's usage; there is nothing to guess when there was no inference, and marking it
  // estimated makes a no-send turn indistinguishable from one whose usage frame never arrived.





  test.skipIf(process.platform === "win32")(
    "appendUsageEntry re-narrows externally widened permissions after the bounded cache window",
    () => {
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now);
      try {
        appendUsageEntry({
          requestId: "ocx-permission-initial",
          timestamp: now,
          provider: "openai",
          model: "gpt-4o",
          status: 200,
          durationMs: 10,
          usageStatus: "unreported",
        });
        chmodSync(testDir, 0o755);
        chmodSync(usageLogPath(), 0o644);

        clock.mockReturnValue(now + 1_000);
        appendUsageEntry({
          requestId: "ocx-permission-recheck",
          timestamp: now + 1_000,
          provider: "openai",
          model: "gpt-4o",
          status: 200,
          durationMs: 11,
          usageStatus: "unreported",
        });

        expect(statSync(testDir).mode & 0o777).toBe(0o700);
        expect(statSync(usageLogPath()).mode & 0o777).toBe(0o600);
      } finally {
        clock.mockRestore();
      }
    },
  );

});
