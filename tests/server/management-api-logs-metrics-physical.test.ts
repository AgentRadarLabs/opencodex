import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { usageLogPath } from "../../src/usage/log";
import {
  addRequestLog,
  clearRequestLogsForTests,
  evictOldestRequestLogForBudget,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { buildRouteDecisionTrace } from "../../src/routing/trace";
import { summarizeUsage } from "../../src/usage/summary";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";

interface LogPollEnvelope {
  logs: Array<Record<string, unknown>>;
  cursor: string;
  reset: boolean;
  generatedAt: number;
  timeZone: string;
  total: number;
}

async function readLogPoll(query = "", cursor?: string): Promise<LogPollEnvelope> {
  const url = new URL(`http://localhost/api/logs?${query}`);
  if (cursor) url.searchParams.set("cursor", cursor);
  const before = Date.now();
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  const body = await response!.json() as LogPollEnvelope;
  expect(body.generatedAt).toBeGreaterThanOrEqual(before);
  expect(body.generatedAt).toBeLessThanOrEqual(Date.now());
  expect(body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(typeof body.cursor).toBe("string");
  return body;
}

const config = { providers: [] } as unknown as OcxConfig;

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  // The request log is process-wide: start empty so the first case does not read a row an
  // earlier file left behind (a one-process tests/server run handed it a Kiro entry).
  clearRequestLogsForTests();
  // addRequestLog persists to usage.jsonl; without a scratch OPENCODEX_HOME a bare
  // `bun test <file>` run from outside the repo (no bunfig preload) writes these
  // fixture rows into the real ~/.opencodex log and poisons the GUI Usage page.
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-logs-metrics-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

async function readLogs(): Promise<Array<Record<string, any>>> {
  const url = new URL("http://localhost/api/logs");
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  const body = await response!.json() as { logs?: Array<Record<string, any>>; timeZone?: string };
  expect(typeof body.timeZone).toBe("string");
  expect(body.timeZone!.length).toBeGreaterThan(0);
  return body.logs ?? [];
}

function baseEntry(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    model: "claude-3-haiku-20240307",
    provider: "anthropic",
    status: 200,
    durationMs: 2000,
    usageStatus: "reported",
    ...overrides,
  };
}

describe("GET /api/logs display metrics", () => {








  test("unmeasured counters are unavailable for both metrics", async () => {
    for (const usageStatus of ["unreported", "unsupported"] as const) {
      addRequestLog(baseEntry({
        requestId: usageStatus,
        usageStatus,
        usage: { inputTokens: 100, outputTokens: 10 },
      }));
    }
    const logs = await readLogs();
    const byStatus = new Map(logs.map(row => [row.usageStatus, row]));
    expect(byStatus.get("unreported")!.displayMetrics).toEqual({
      tokPerSecond: { kind: "unavailable", reason: "usage_missing" },
      decodeTokPerSecond: { kind: "unavailable", reason: "ttft_missing" },
      cost: { kind: "unavailable", reason: "usage_missing" },
    });
    expect(byStatus.get("unsupported")!.displayMetrics).toEqual({
      tokPerSecond: { kind: "unavailable", reason: "usage_unsupported" },
      decodeTokPerSecond: { kind: "unavailable", reason: "usage_unsupported" },
      cost: { kind: "unavailable", reason: "usage_unsupported" },
    });
  });



  test("partial combo keeps measured attempt metrics without pricing unreported counters", async () => {
    addRequestLog(baseEntry({
      provider: "combo",
      model: "combo/my-combo",
      usageStatus: "unreported",
      usage: { inputTokens: 200, outputTokens: 20 },
      attempts: [
        {
          ordinal: 1,
          provider: "anthropic",
          model: "claude-3-haiku-20240307",
          adapter: "anthropic",
          status: 429,
          durationMs: 900,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
        {
          ordinal: 2,
          provider: "anthropic",
          model: "claude-3-haiku-20240307",
          adapter: "anthropic",
          status: 200,
          durationMs: 1100,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "unreported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      ],
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "unavailable", reason: "usage_missing" });
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "combo_attempt_unavailable" });
    expect(dto!.attempts[0].displayMetrics.cost.kind).toBe("value");
    expect(dto!.attempts[0].displayMetrics.tokPerSecond.kind).toBe("value");
    expect(dto!.attempts[1].displayMetrics.cost).toEqual({ kind: "unavailable", reason: "usage_missing" });
    expect(dto!.attempts[1].displayMetrics.tokPerSecond).toEqual({ kind: "unavailable", reason: "usage_missing" });
  });

  test("aggregate cost excludes local, unsent, and duplicate attempts", async () => {
    const physical = {
      ordinal: 1,
      provider: "anthropic",
      model: "claude-3-haiku-20240307",
      adapter: "anthropic" as const,
      status: 200,
      durationMs: 900,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    };
    addRequestLog(baseEntry({
      provider: "combo",
      model: "combo/my-combo",
      usage: { inputTokens: 999, outputTokens: 999 },
      attempts: [
        physical,
        { ...physical, ordinal: 2, provider: "local-only", locallyAnswered: true },
        { ...physical, ordinal: 3, provider: "unsent", sendCount: 0 },
        { ...physical, provider: "duplicate" },
      ],
    }));

    const [dto] = await readLogs();
    expect(dto!.attempts).toHaveLength(4);
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.cost.total)
      .toBe(dto!.attempts[0].displayMetrics.cost.estimate.cost.total);
  });

  test("uses legacy root usage to price its final physical attempt", async () => {
    addRequestLog(baseEntry({
      provider: "combo",
      model: "combo/my-combo",
      usage: { inputTokens: 100, outputTokens: 10 },
      attempts: [{
        ordinal: 1,
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        adapter: "anthropic",
        status: 200,
        durationMs: 900,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
      }],
    }));

    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.attempts).toHaveLength(1);
  });

  test("explicit all-nonphysical attempts do not reuse stale root cost", async () => {
    const nonphysical = {
      ordinal: 1,
      provider: "anthropic",
      model: "claude-3-haiku-20240307",
      adapter: "anthropic" as const,
      status: 200,
      durationMs: 900,
      sendCount: 0,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    };
    addRequestLog(baseEntry({
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
      attempts: [nonphysical, { ...nonphysical, ordinal: 2, sendCount: 1, locallyAnswered: true }],
    }));

    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "usage_missing" });
  });



});
import { ManagementRequest as Request } from "../helpers/management-auth";


describe("GET /api/logs snapshot polling", () => {
  beforeEach(() => clearRequestLogsForTests());




});

/**
 * #4057: the account label was persisted on the row and on every attempt long before anything
 * could read it back. `requestLogDto` carries it only because it spreads the entry — the sibling
 * projection `requestLogEntryFromPersistedUsage` rebuilds field by field and warns in its own
 * comment that a field missing there never reaches usage.jsonl. These assertions pin the served
 * contract so a future field-by-field rewrite of the DTO cannot drop the label silently.
 */
describe("GET /api/logs account identity", () => {
  beforeEach(() => clearRequestLogsForTests());

});

/**
 * #4038 — Logs showed one rate that conflates first-token latency with delivery speed.
 * `tokensPerSecond` never subtracted TTFT, and the MetricSource Pick did not even include
 * `firstOutputMs`, so a decode-rate metric could not be computed at all.
 *
 * The history matters more than the arithmetic here. Contributor PR #4040 implemented this exact
 * metric and was closed unmerged as an unreliable estimate: proxy TTFT is not the provider's
 * generation window, and a small post-TTFT remainder makes the number explode. The issue stayed
 * open, so the repository held both an acceptance criterion and a rejection of the same feature.
 *
 * MIN_DECODE_WINDOW_MS is what answers that rejection, and
 * "a decode window under the floor yields no value" is the assertion that proves it. Everything
 * else here is scaffolding around that one case.
 */
describe("estimated decode rate (#4038)", () => {








});
