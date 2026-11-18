import { describe, expect, test } from "bun:test";
import {
  MAX_USAGE_MODEL_BREAKDOWN_ROWS,
  MAX_USAGE_DAY_BUCKETS,
  USAGE_RANGES,
  USAGE_SURFACES,
  createUsageSummaryAccumulator,
  cacheTokensFromUsage,
  parseRange,
  parseUsageSurface,
  projectedComboUsage,
  projectUsageSummary,
  rangeWindow,
  summarizeUsage,
} from "../../src/usage/summary";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { computeEntryCost } from "../../src/usage/summary";
import { buildRouteDecisionTrace } from "../../src/routing/trace";
import { isUnresolvedRequestedModel } from "../../src/usage/model-identity";

const FIXED_NOW = Date.UTC(2026, 5, 28, 12, 0, 0);

describe("custom usage windows", () => {

  const since = new Date(2026, 1, 10, 12, 0, 0, 123).getTime();
  const until = since + 3_600_000;






});

function entry(overrides: Partial<PersistedUsageEntry> & { ts: number }): PersistedUsageEntry {
  const { ts, ...rest } = overrides;
  return {
    requestId: rest.requestId ?? `req-${ts}`,
    timestamp: ts,
    provider: rest.provider ?? "openai",
    model: rest.model ?? "gpt-5.5",
    status: rest.status ?? 200,
    durationMs: rest.durationMs ?? 10,
    usageStatus: rest.usageStatus ?? "unreported",
    ...(rest.surface === "claude" ? { surface: rest.surface } : {}),
    ...(rest.accountLogLabel !== undefined ? { accountLogLabel: rest.accountLogLabel } : {}),
    ...(rest.resolvedModel !== undefined ? { resolvedModel: rest.resolvedModel } : {}),
    ...(rest.usage ? { usage: rest.usage } : {}),
    ...(rest.totalTokens !== undefined ? { totalTokens: rest.totalTokens } : {}),
    ...(rest.attempts ? { attempts: rest.attempts } : {}),
    ...(rest.apiKeyId !== undefined ? { apiKeyId: rest.apiKeyId } : {}),
    ...(rest.routeDecision ? { routeDecision: rest.routeDecision } : {}),
  };
}

describe("unresolved requested model attribution", () => {
  function fallback(model: string, overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
    return entry({
      ts: FIXED_NOW - 1, provider: "kimi", model, usageStatus: "reported",
      usage: { inputTokens: 30, outputTokens: 8 }, totalTokens: 38,
      routeDecision: buildRouteDecisionTrace({
        requestedModel: model, routeKind: "default-provider",
        selected: { provider: "kimi", model, reason: "default-provider" },
      }),
      ...overrides,
    });
  }






});

describe("parseRange", () => {

});

describe("today range (CLI cost query)", () => {


});

describe("day-level estimated cost", () => {
  const at = Date.UTC(2026, 5, 28, 10, 0, 0);





  // Only the tail row carries cache telemetry, so its 100 input tokens are the whole denominator
  // (`cacheObservedInputTokens`); the other rows folded into "other" never measured cache and
  // are not miss evidence. A read ABOVE that denominator is contradictory telemetry, which
  // `cacheTokensFromUsage` refuses outright, so the clamp is only reachable at exactly 1.
});


describe("canonical range and surface constants", () => {
});

describe("projectUsageSummary", () => {
  const at = Date.UTC(2026, 5, 28, 10, 0, 0);
  const priced = { inputTokens: 1_000, outputTokens: 100 };




  test("projects additive usage with the latest context checkpoint and bounded server-tool sums", () => {
    const attempts: NonNullable<PersistedUsageEntry["attempts"]> = [
      {
        ordinal: 1,
        provider: "anthropic",
        model: "claude-opus-5",
        adapter: "anthropic",
        status: 502,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          contextTotalTokens: 100,
          reasoningOutputTokens: 2,
          anthropicServerToolUse: {
            web_search_requests: 1,
            invalid_negative: -1,
            invalid_infinite: Number.POSITIVE_INFINITY,
          },
        },
        totalTokens: 11,
      },
      {
        ordinal: 2,
        provider: "anthropic",
        model: "claude-opus-5",
        adapter: "anthropic",
        status: 502,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: {
          inputTokens: 20,
          outputTokens: 2,
          anthropicServerToolUse: { web_search_requests: 2, web_fetch_requests: 1 },
        },
        totalTokens: 22,
      },
      {
        ordinal: 3,
        provider: "anthropic",
        model: "claude-opus-5",
        adapter: "anthropic",
        status: 200,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: {
          inputTokens: 30,
          outputTokens: 3,
          contextTotalTokens: 80,
          reasoningOutputTokens: 3,
          anthropicServerToolUse: { web_search_requests: 3 },
        },
        totalTokens: 33,
      },
    ];

    expect(projectedComboUsage(attempts)).toEqual({
      usage: {
        inputTokens: 60,
        outputTokens: 6,
        contextTotalTokens: 80,
        reasoningOutputTokens: 5,
        anthropicServerToolUse: { web_search_requests: 6, web_fetch_requests: 1 },
      },
      totalTokens: 66,
    });
  });






});

describe("parseUsageSurface", () => {

});

describe("summarizeUsage", () => {









  test("canonical implicit cache reads are not reduced by cache writes", () => {
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW - 1000,
      provider: "anthropic",
      usageStatus: "reported",
      usage: {
        inputTokens: 160,
        outputTokens: 10,
        cachedInputTokens: 60,
        cacheCreationInputTokens: 20,
      },
      totalTokens: 170,
    })], "30d", FIXED_NOW);

    expect(sum.summary).toMatchObject({
      inputTokens: 160,
      outputTokens: 10,
      cachedInputTokens: 60,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 20,
      totalTokens: 170,
    });
  });










  test("preserves stored totals when physical attempt usage is unavailable", () => {
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW - 1,
      requestId: "combo-total-only",
      provider: "combo",
      model: "combo/free",
      usageStatus: "unreported",
      attempts: [{
        ordinal: 1,
        provider: "openai",
        model: "gpt-5.5",
        adapter: "openai-responses",
        accountLogLabel: "main",
        status: 200,
        durationMs: 2,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
        totalTokens: 17,
      }],
    })], "30d", FIXED_NOW);

    expect(sum.summary.totalTokens).toBe(17);
    expect(sum.days.find(day => day.requests === 1)?.totalTokens).toBe(17);
    expect(sum.days.find(day => day.requests === 1)?.models[0]?.totalTokens).toBe(17);
    expect(sum.models[0]?.totalTokens).toBe(17);
    expect(sum.providers[0]?.totalTokens).toBe(17);
    expect(sum.accounts[0]).toMatchObject({
      accountLogLabel: "main",
      totalTokens: 17,
      measuredAttempts: 0,
      unmeteredAttempts: 1,
      usageCoverageRatio: 0,
    });
  });

  test("filters duplicate, local, and unsent attempts before every summary aggregate", () => {
    const physical = {
      ordinal: 1,
      provider: "openai",
      model: "gpt-5.5",
      adapter: "openai-chat",
      status: 200,
      durationMs: 2,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      usage: { inputTokens: 10, outputTokens: 2 },
      totalTokens: 12,
    };
    const combo = entry({
      ts: FIXED_NOW - 1,
      requestId: "combo-physical-only",
      provider: "combo",
      model: "combo/free",
      usageStatus: "reported",
      usage: { inputTokens: 9_999, outputTokens: 999 },
      totalTokens: 10_998,
      attempts: [
        physical,
        { ...physical },
        {
          ...physical,
          ordinal: 2,
          provider: "local",
          model: "local-model",
          locallyAnswered: true,
          usage: { inputTokens: 1_000, outputTokens: 100 },
          totalTokens: 1_100,
        },
        {
          ...physical,
          ordinal: 3,
          provider: "unsent",
          model: "unsent-model",
          status: 502,
          sendCount: 0,
          usage: { inputTokens: 2_000, outputTokens: 200 },
          totalTokens: 2_200,
        },
      ],
    });

    const sum = summarizeUsage([combo], "30d", FIXED_NOW);
    expect(sum.summary).toMatchObject({
      requests: 1,
      attemptCount: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
    expect(sum.providers).toHaveLength(1);
    expect(sum.providers[0]).toMatchObject({
      provider: "openai",
      requests: 1,
      attemptCount: 1,
      totalTokens: 12,
    });
    expect(sum.models).toHaveLength(1);
    expect(sum.models[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      requests: 1,
      attemptCount: 1,
      totalTokens: 12,
    });
  });

  test("attributes legacy root usage to final physical attempt when attempt usage is absent", () => {
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW - 1,
      requestId: "combo-root-fallback",
      provider: "combo",
      model: "combo/free",
      usageStatus: "reported",
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
      },
      totalTokens: 105,
      attempts: [{
        ordinal: 1,
        provider: "anthropic",
        model: "claude-opus-5",
        adapter: "anthropic",
        status: 200,
        durationMs: 2,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
      }],
    })], "30d", FIXED_NOW);

    expect(sum.summary).toMatchObject({
      requests: 1,
      attemptCount: 1,
      measuredRequests: 1,
      inputTokens: 100,
      outputTokens: 5,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      totalTokens: 105,
    });
    expect(sum.providers).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        requests: 1,
        attemptCount: 1,
        totalTokens: 105,
      }),
    ]);
  });

  test("an explicit empty attempt list never falls back to stale parent usage", () => {
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW - 1,
      requestId: "combo-empty",
      provider: "combo",
      model: "combo/free",
      usageStatus: "reported",
      usage: { inputTokens: 9_999, outputTokens: 999 },
      totalTokens: 10_998,
      attempts: [],
    })], "30d", FIXED_NOW);

    expect(sum.summary).toMatchObject({
      requests: 1,
      attemptCount: 0,
      measuredRequests: 0,
      totalTokens: 0,
    });
  });

  test("an all-nonphysical attempt list never falls back to stale parent usage", () => {
    const diagnostic = {
      ordinal: 1,
      provider: "local",
      model: "local-model",
      adapter: "anthropic",
      status: 200,
      durationMs: 1,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      locallyAnswered: true,
      usage: { inputTokens: 1_000, outputTokens: 100 },
      totalTokens: 1_100,
    };
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW - 1,
      requestId: "combo-nonphysical-only",
      provider: "combo",
      model: "combo/free",
      usageStatus: "reported",
      usage: { inputTokens: 9_999, outputTokens: 999 },
      totalTokens: 10_998,
      attempts: [diagnostic, {
        ...diagnostic,
        ordinal: 2,
        provider: "unsent",
        locallyAnswered: false,
        sendCount: 0,
      }],
    })], "30d", FIXED_NOW);

    expect(sum.summary).toMatchObject({
      requests: 1,
      attemptCount: 0,
      measuredRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(sum.providers).toEqual([]);
    expect(sum.models).toEqual([]);
  });








  test("lets unpriced attempts dominate priced attempts in the collapsed model row", () => {
    const retained = Array.from({ length: MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1 }, (_, index) =>
      [0, 1].map(request => entry({
        ts: FIXED_NOW - index * 2 - request,
        requestId: `retained-${index}-${request}`,
        provider: `provider-${index}`,
        model: `model-${index}`,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 1 },
      }))).flat();
    const mixed = entry({
      ts: FIXED_NOW,
      requestId: "mixed-overflow-pricing",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
        {
          ordinal: 2,
          provider: "openai",
          model: "unpriced-overflow-model",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      ],
    });

    const sum = summarizeUsage([...retained, mixed], "30d", FIXED_NOW);
    expect(sum.models.at(-1)).toMatchObject({
      provider: "other",
      model: "other",
      requests: 1,
      pricedRequests: 0,
      unpricedRequests: 1,
      priceCoverageRatio: 0,
    });
  });



  test.each([
    ["canonical", { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 150 }],
    ["legacy", { inputTokens: 100, outputTokens: 20, cachedInputTokens: 150, cacheCreationInputTokens: 80 }],
  ])("keeps contradictory %s cache telemetry unavailable", (_kind, usage) => {
    expect(cacheTokensFromUsage(usage)).toEqual({
      read: undefined,
      creation: undefined,
      hasCacheTelemetry: false,
    });

    const sum = summarizeUsage([
      entry({
        ts: FIXED_NOW - 1000,
        provider: "anthropic",
        model: "claude-sonnet-5",
        usageStatus: "reported",
        usage,
      }),
    ], "30d", FIXED_NOW);
    expect(sum.models[0]?.cacheHitRate).toBeNull();
  });

  test("keeps same-route mixed physical pricing below full coverage", () => {
    const sum = summarizeUsage([entry({
      ts: FIXED_NOW - 1000,
      requestId: "same-route-mixed-pricing",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-responses",
          status: 502,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
        {
          ordinal: 2,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-responses",
          status: 200,
          durationMs: 20,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "unreported",
        },
      ],
    })], "30d", FIXED_NOW);

    expect(sum.models.find(model => model.model === "gpt-5.5")).toMatchObject({
      requests: 1,
      pricedRequests: 0,
      unpricedRequests: 1,
      priceCoverageRatio: 0,
    });
    expect(sum.providers.find(provider => provider.provider === "openai")).toMatchObject({
      requests: 1,
      pricedRequests: 0,
      unpricedRequests: 1,
      priceCoverageRatio: 0,
    });
  });


});

describe("UsageSummaryAccumulator modes", () => {
  const at = Date.UTC(2026, 5, 28, 10, 0, 0);








});

test("a refused attempt does not zero the cost of the attempt that succeeded", () => {
  // Combo failover: target 1 is refused (a physical send, no usage to price), target 2 serves the
  // turn. Treating the refusal as UNPRICEABLE rather than as a known zero reported the whole
  // request at $0, so real money spent on target 2 disappeared from the daily total.
  const entry = {
    requestId: "combo-failover-cost",
    timestamp: Date.now(),
    provider: "combo",
    model: "combo/waterfall",
    status: 200,
    durationMs: 900,
    usageStatus: "reported",
    attempts: [
      {
        ordinal: 1, provider: "openai", model: "gpt-5.6", adapter: "openai-responses",
        status: 429, durationMs: 40, sendCount: 1, recoveryKinds: [], usageStatus: "unreported",
      },
      {
        ordinal: 2, provider: "anthropic", model: "claude-opus-4-5", adapter: "anthropic",
        status: 200, durationMs: 800, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
        usage: { inputTokens: 50_000, outputTokens: 1_000, totalTokens: 51_000 },
      },
    ],
  } as unknown as PersistedUsageEntry;

  const cost = computeEntryCost(entry);

  expect(cost.isPriced).toBe(true);
  expect(cost.costTotal).toBeGreaterThan(0);
});
