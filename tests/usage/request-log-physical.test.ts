import { describe, expect, spyOn, test } from "bun:test";
import {
  filterRequestLogs,
  addFinalRequestLog,
  httpStatusFromTerminalError,
  nextRequestLogId,
  responseWithDeferredRequestLog,
  requestLogErrorCode,
  requestLogSpeedLabel,
  type RequestLogEntry,
} from "../../src/server";
import {
  aggregateAttemptUsage,
  addRequestLog,
  beginRequestAttempt,
  clearRequestLogsForTests,
  finishRequestAttempt,
  getRequestLogEntries,
  hydrateRequestLogsFromDisk,
  noteAttemptSend,
  noteProviderAttemptSend,
  recordAdapterReasoning,
  recordFirstOutput,
  requestLogEntryFromPersistedUsage,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
  inspectResponseLogSsePayload,
  httpStatusForRequestLogTerminal,
  type RequestLogContext,
} from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import { bridgeToResponsesSSE } from "../../src/bridge";
import type { AdapterEvent, OcxConfig, OcxProviderConfig, OcxUsage } from "../../src/types";
import {
  appendUsageEntry,
  normalizeUsageEntryForTest,
  readUsageEntries,
  resetUsageReadCacheForTests,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { log } from "../helpers/request-log-entry";
import { decodeRequestLogCursor, selectRequestLogPoll } from "../../src/server/request-log-cursor";

async function* replayAdapterEvents(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

describe("request log metadata", () => {



  for (const error of [
    { type: "authentication_error", message: "Usage limit lookup requires renewed authentication" },
    { code: "invalid_api_key", message: "Usage limit unavailable for this credential" },
  ]) {
  }








  test("records only valid adapter prompt-cache TTL metadata on the active attempt", () => {
    const attempt = beginRequestAttempt(1, "anthropic", "claude-opus-5", "anthropic");
    const logCtx: RequestLogContext = {
      model: "claude-opus-5",
      provider: "anthropic",
      activeAttempt: attempt,
    };
    const request = {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {},
      body: "{}",
      promptCacheTtlMs: 3_600_000,
    };

    recordAdapterReasoning(logCtx, request as never);
    expect((attempt as unknown as { promptCacheTtlMs?: number }).promptCacheTtlMs).toBe(3_600_000);

    recordAdapterReasoning(logCtx, { ...request, promptCacheTtlMs: -1 } as never);
    expect((attempt as unknown as { promptCacheTtlMs?: number }).promptCacheTtlMs).toBeUndefined();
  });







  // The value is caller-controlled, so proving it lands is only half the contract: the
  // persistence path must also be the SANITIZED one. A test that only ever writes a safe
  // short slug passes identically whether `sanitizeLogMetadataString` is applied or not.

  // `addFinalRequestLog` is not the only ingress: `addRequestLog` is exported and callable
  // directly. Sanitizing only on the disk projection left the in-memory ring — and therefore
  // /api/logs — serving the raw value, which is the worst shape for a sanitization bug
  // because the surface you would check is the clean one.

  test("captures first physical send time once across retries", () => {
    const attempt = beginRequestAttempt(1, "anthropic", "claude-opus-5", "anthropic");

    noteAttemptSend(attempt, undefined, undefined, 123.25);
    noteAttemptSend(attempt, undefined, "transient-5xx", 456.5);

    expect(attempt.firstSendAt).toBe(123.25);
    expect(attempt.sendCount).toBe(2);
  });


  test("keeps the latest context checkpoint while adding server tool counters", () => {
    const first = beginRequestAttempt(1, "a", "m1", "anthropic");
    noteAttemptSend(first, undefined);
    finishRequestAttempt(
      first,
      429,
      1,
      {
        inputTokens: 10,
        outputTokens: 1,
        contextTotalTokens: 90,
        anthropicServerToolUse: { web_search_requests: 1 },
      },
    );
    const second = beginRequestAttempt(2, "a", "m1", "anthropic");
    noteAttemptSend(second, undefined);
    finishRequestAttempt(
      second,
      200,
      1,
      {
        inputTokens: 12,
        outputTokens: 2,
        contextTotalTokens: 80,
        anthropicServerToolUse: { web_search_requests: 2, web_fetch_requests: 1 },
      },
    );

    expect(aggregateAttemptUsage([first, second])).toMatchObject({
      usage: {
        inputTokens: 22,
        outputTokens: 3,
        contextTotalTokens: 80,
        anthropicServerToolUse: { web_search_requests: 3, web_fetch_requests: 1 },
      },
    });
  });

  test("explicit attempts do not reuse stale root usage when no physical usage survives", () => {
    const local = beginRequestAttempt(1, "local", "m1", "anthropic");
    local.locallyAnswered = true;
    finishRequestAttempt(local, 200, 1, { inputTokens: 30, outputTokens: 3 });
    const unsent = finishRequestAttempt(
      beginRequestAttempt(2, "unsent", "m2", "anthropic"),
      502,
      1,
      { inputTokens: 40, outputTokens: 4 },
    );

    for (const [requestId, attempts] of [
      ["explicit-empty", []],
      ["explicit-nonphysical", [local, unsent]],
    ] as const) {
      const entries: RequestLogEntry[] = [];
      addFinalRequestLog(requestId, Date.now(), {
        model: "stale-model",
        provider: "stale-provider",
        usage: { inputTokens: 99, outputTokens: 9 },
        attempts: [...attempts],
      }, 200, undefined, entry => entries.push(entry));

      expect(entries[0]?.usageStatus).toBe("unreported");
      expect(entries[0]).not.toHaveProperty("usage");
      expect(entries[0]).not.toHaveProperty("totalTokens");
    }
  });

  test("final logging derives tier outcome from the last unique physical attempt", () => {
    const first = beginRequestAttempt(1, "a", "m1", "anthropic");
    noteAttemptSend(first, undefined);
    first.tierOutcome = {
      wireValue: "first",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(first, 429, 1);
    const final = beginRequestAttempt(2, "b", "m2", "anthropic");
    noteAttemptSend(final, undefined);
    final.tierOutcome = {
      wireValue: "final",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(final, 200, 1);
    const duplicate = {
      ...final,
      tierOutcome: {
        wireValue: "duplicate",
        fastOutcome: "downgraded" as const,
        confirmation: "downgraded" as const,
      },
    };
    const local = beginRequestAttempt(3, "local", "m3", "anthropic");
    local.locallyAnswered = true;
    local.tierOutcome = {
      wireValue: "local",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(local, 200, 1);
    const unsent = beginRequestAttempt(4, "unsent", "m4", "anthropic");
    unsent.tierOutcome = {
      wireValue: "unsent",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(unsent, 502, 1);
    const rootFallback = {
      wireValue: "stale-root",
      fastOutcome: "unknown" as const,
      confirmation: "unknown" as const,
    };
    const entries: RequestLogEntry[] = [];

    addFinalRequestLog("tier-physical", Date.now(), {
      model: "m2",
      provider: "b",
      attempts: [first, final, duplicate, local, unsent],
      tierOutcome: rootFallback,
    }, 200, undefined, entry => entries.push(entry));

    expect(entries[0]?.tierOutcome).toEqual(final.tierOutcome);

    const fallbackEntries: RequestLogEntry[] = [];
    const physicalWithoutTier = beginRequestAttempt(1, "a", "m1", "anthropic");
    noteAttemptSend(physicalWithoutTier, undefined);
    finishRequestAttempt(physicalWithoutTier, 200, 1);
    addFinalRequestLog("tier-fallback", Date.now(), {
      model: "m1",
      provider: "a",
      attempts: [physicalWithoutTier],
      tierOutcome: rootFallback,
    }, 200, undefined, entry => fallbackEntries.push(entry));
    expect(fallbackEntries[0]?.tierOutcome).toEqual(rootFallback);
  });

  test("hydration derives tier outcome from the last unique physical attempt", () => {
    const first = beginRequestAttempt(1, "a", "m1", "anthropic");
    noteAttemptSend(first, undefined);
    first.tierOutcome = {
      wireValue: "first",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(first, 429, 1);
    const final = beginRequestAttempt(2, "b", "m2", "anthropic");
    noteAttemptSend(final, undefined);
    final.tierOutcome = {
      wireValue: "final",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(final, 200, 1);
    const duplicate = {
      ...final,
      tierOutcome: {
        wireValue: "duplicate",
        fastOutcome: "downgraded" as const,
        confirmation: "downgraded" as const,
      },
    };
    const trailingLocal = beginRequestAttempt(3, "local", "m3", "anthropic");
    trailingLocal.locallyAnswered = true;
    trailingLocal.tierOutcome = {
      wireValue: "local",
      fastOutcome: "applied",
      confirmation: "confirmed",
    };
    finishRequestAttempt(trailingLocal, 200, 1);

    const projected = requestLogEntryFromPersistedUsage({
      requestId: "hydrated-tier",
      timestamp: 1,
      model: "m2",
      provider: "b",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
      attempts: [first, final, duplicate, trailingLocal],
      tierOutcome: {
        wireValue: "stale-root",
        fastOutcome: "unknown",
        confirmation: "unknown",
      },
    });

    expect(projected.tierOutcome).toEqual(final.tierOutcome);
  });

  test("aggregates only unique sent physical attempts", () => {
    const physical = beginRequestAttempt(1, "a", "m1", "anthropic");
    noteAttemptSend(physical, undefined);
    finishRequestAttempt(physical, 200, 1, { inputTokens: 10, outputTokens: 2 });
    const duplicate = { ...physical };
    const local = beginRequestAttempt(2, "local", "m2", "anthropic");
    local.locallyAnswered = true;
    finishRequestAttempt(local, 200, 1, { inputTokens: 1_000, outputTokens: 100 });
    const unsent = finishRequestAttempt(
      beginRequestAttempt(3, "unsent", "m3", "anthropic"),
      502,
      1,
      { inputTokens: 2_000, outputTokens: 200 },
    );

    expect(aggregateAttemptUsage([physical, duplicate, local, unsent])).toMatchObject({
      totalTokens: 12,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
  });

  test("finalized attempts reopen only when another send starts", () => {
    const attempt = beginRequestAttempt(1, "a", "m1", "anthropic");
    noteAttemptSend(attempt, undefined);
    finishRequestAttempt(attempt, 200, 10, { inputTokens: 10, outputTokens: 2 });

    finishRequestAttempt(attempt, 502, 20, { inputTokens: 99, outputTokens: 9 });
    expect(attempt).toMatchObject({
      status: 200,
      durationMs: 10,
      usage: { inputTokens: 10, outputTokens: 2 },
    });

    noteAttemptSend(attempt, undefined);
    expect(attempt.status).toBe(0);
    finishRequestAttempt(attempt, 502, 30, { inputTokens: 12, outputTokens: 3 });
    expect(attempt).toMatchObject({
      status: 502,
      durationMs: 30,
      sendCount: 2,
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });



  test("request aggregate is not assigned to a later attempt that reported no usage", () => {
    const entries: RequestLogEntry[] = [];
    const first = beginRequestAttempt(1, "a", "model-a", "anthropic");
    noteAttemptSend(first, undefined);
    finishRequestAttempt(first, 429, 3, { inputTokens: 10, outputTokens: 4 });
    const final = beginRequestAttempt(2, "b", "model-b", "anthropic");
    noteAttemptSend(final, "oauth-account-429");
    const start = Date.now();
    const logCtx = {
      model: "combo/free",
      provider: "combo",
      usage: { inputTokens: 10, outputTokens: 4 },
      usageIsRequestAggregate: true,
      attempts: [first, final],
      activeAttempt: final,
      activeAttemptStartedAt: start,
    } as RequestLogContext & { usageIsRequestAggregate: boolean };

    addFinalRequestLog("aggregate-after-rotation", start, logCtx, 502, undefined, entry => entries.push(entry));

    expect(entries[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(entries[0]?.attempts?.[1]?.usage).toBeUndefined();
  });

  test("final non-combo logging aggregates every explicit physical attempt", () => {
    const entries: RequestLogEntry[] = [];
    const first = beginRequestAttempt(1, "a", "model-a", "openai-chat");
    noteAttemptSend(first, undefined);
    finishRequestAttempt(
      first,
      503,
      3,
      { inputTokens: 4, outputTokens: 1, cacheReadInputTokens: 2 },
    );
    const final = beginRequestAttempt(2, "b", "model-b", "openai-chat");
    noteAttemptSend(final, undefined);
    const start = Date.now();
    addFinalRequestLog("policy-parent", start, {
      model: "policy/fast",
      provider: "policy",
      requestedModel: "policy/fast",
      providerAdapter: "openai-chat",
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 },
      attempts: [first, final],
      activeAttempt: final,
      activeAttemptStartedAt: start,
    }, 200, undefined, entry => entries.push(entry));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "policy",
      model: "policy/fast",
      usageStatus: "reported",
      usage: {
        inputTokens: 14,
        outputTokens: 3,
        cachedInputTokens: 9,
        cacheReadInputTokens: 9,
      },
      attempts: [
        { provider: "a", usage: { inputTokens: 4, cacheReadInputTokens: 2 } },
        { provider: "b", usage: { inputTokens: 10, cachedInputTokens: 7 } },
      ],
    });
  });











  /**
   * #2704: there was no `model` clause at all, so `?model=x` was accepted and silently
   * ignored -- every row came back, and `ocx logs --model x` looked like it had filtered.
   * The non-matching assertion is the one that matters: an unfiltered implementation passes
   * the positive case for free.
   */

  /**
   * #4057: the account label was already persisted on every row and every attempt, but nothing
   * could select on it, so "which of my accounts served this?" could only be answered by
   * grepping usage.jsonl. The non-matching assertion is the one that matters: an implementation
   * that ignores `account` entirely passes the positive cases for free.
   */






























});

describe("request log restart hydrate", () => {




});


describe("request log snapshot cursor", () => {
  const epoch = "a".repeat(32);
  const query = new URLSearchParams("limit=2000");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");





});
