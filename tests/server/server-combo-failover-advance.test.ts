import { registerComboForcedEffortCases } from "../helpers/combo-forced-effort-cases";
import { registerComboToolRoutingCases } from "../helpers/combo-tool-routing-cases";
import { comboProviderFactory } from "../helpers/combo-provider";
import { registerComboContextOverflowCases } from "../helpers/combo-context-overflow-cases";
import { registerComboContextHeadroomCases } from "../helpers/combo-context-headroom-cases";
import { sessionLaneIdFromRequest } from "../../src/server/request-log-conversation";
import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { logsFromApiBody } from "../helpers/logs-api";
import { computeRoutingAnalytics } from "../../src/routing/analytics";
import { managementFetch as fetch, ManagementRequest as Request } from "../helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  isComboTargetInCooldown,
} from "../../src/combos";
import { readConfigDiagnostics, saveConfig } from "../../src/config";
import type { ProviderAdapter } from "../../src/adapters/base";
import { handleManagementAPI } from "../../src/server/management-api";
import { saveCredential } from "../../src/oauth/store";
import { XAI_OAUTH_DISCOVERY_URL } from "../../src/oauth/xai";
import { XAI_GROK_CLI_BASE_URL } from "../../src/providers/xai-transport";
import type { AdapterEvent, OcxConfig, OcxProviderConfig, OcxProviderContinuationState } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { clearRequestLogsForTests, hydrateRequestLogsFromDisk, httpStatusForRequestLogTerminal, inspectResponseLogSsePayload, type RequestLogContext } from "../../src/server/request-log";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import { readUsageEntries } from "../../src/usage/log";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  clearCodexUpstreamHealth,
  formatCodexProviderForLog,
  getCodexUpstreamHealth,
  getCodexQuotaHealthSnapshot,
  codexQuotaScopeForModel,
} from "../../src/codex/routing";
import { clearAccountQuota, getAccountQuota } from "../../src/codex/quota";
import { startServer } from "../../src/server";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { chatErrorStream, chatStream, chatSuccess, chatTruncatedZeroOutputStream, responsesSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { heldResponse } from "../helpers/held-response";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import { clearCursorThreadContinuityForTests } from "../../src/adapters/cursor/thread-continuity";
import { COMPACT_PROMPT, encodeCompactionSummary } from "../../src/responses/compaction";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { consumeComboFailure, createChildPassthroughCallbackGate } from "../../src/server/responses/core";
import { clearComboRecallForTests, recallComboForLane, reconcileComboRecall } from "../../src/server/responses/combo-session-recall";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";

// Full-suite Windows load: startServer + combo rename/delete management flows exceed the
// default 5s per-test budget (same flake class as 810fa115 / claude-management-api).
setDefaultTimeout(30_000);

// `mock.module` outlives this file: Bun keeps both overrides below for every file that runs after
// this one in the same process. These are spread snapshots of the real modules, taken before them.
const actualResolver = { ...(await import("../../src/server/adapter-resolve")) };
const actualResolveAdapter = actualResolver.resolveAdapter;
const actualRetry = { ...(await import("../../src/lib/upstream-retry")) };
const actualFetchWithTransientRetry = actualRetry.fetchWithTransientRetry;
const { createCursorAdapter } = await import("../../src/adapters/cursor");
import type { CursorTransportFactory } from "../../src/adapters/cursor/transport";
let customRunTurn: NonNullable<ProviderAdapter["runTurn"]> | undefined;
let customFetchResponse: NonNullable<ProviderAdapter["fetchResponse"]> | undefined;
const provider = comboProviderFactory(() => customFetchResponse);
let customTransientResponse: (() => Promise<Response>) | undefined;
let customUsageEstimate: ((model: string) => number | undefined) | undefined;
let customCursorTransportFactory: CursorTransportFactory | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "cursor" && customCursorTransportFactory) {
      // Real cursor adapter (adapter.name === "cursor") over a fake transport, so server-level
      // tests can drive the genuine continuation/persistence policy without a live socket.
      return createCursorAdapter(provider, { createTransport: customCursorTransportFactory });
    }
    if (
      provider.adapter === "test-run-turn"
      || provider.adapter === "test-kiro"
      || provider.adapter === "test-owned"
    ) {
      const adapter: ProviderAdapter = {
        name: provider.adapter === "test-kiro" ? "kiro" : provider.adapter,
        buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
        async *parseStream(): AsyncGenerator<AdapterEvent> {
          yield { type: "error", message: "test runTurn adapter does not use parseStream" };
        },
        async runTurn(parsed, incoming, emit) {
          if (!customRunTurn) throw new Error("custom runTurn not installed");
          await customRunTurn(parsed, incoming, emit);
        },
      };
      return adapter;
    }
    if (provider.adapter === "test-response") {
      const base = actualResolveAdapter({ ...provider, adapter: "openai-chat" }, cacheRetention);
      return {
        ...base,
        name: "test-response",
        async buildRequest(parsed, options) {
          const request = await base.buildRequest(parsed, options);
          const estimate = customUsageEstimate?.(parsed.modelId);
          return estimate === undefined
            ? request
            : { ...request, usageLog: { inputTokens: estimate } };
        },
        async fetchResponse(request, context) {
          if (!customFetchResponse) throw new Error("custom fetchResponse not installed");
          return context!.executor!(request.url, { method: request.method, headers: request.headers,
            body: request.body, signal: context?.abortSignal });
        },
      };
    }
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

mock.module("../../src/lib/upstream-retry", () => ({
  ...actualRetry,
  fetchWithTransientRetry(
    ...args: Parameters<typeof actualFetchWithTransientRetry>
  ): ReturnType<typeof actualFetchWithTransientRetry> {
    if (customTransientResponse) return customTransientResponse();
    return actualFetchWithTransientRetry(...args);
  },
}));

afterAll(() => {  // Put the real modules back for every later file in the same process.
  mock.module("../../src/server/adapter-resolve", () => actualResolver);
  mock.module("../../src/lib/upstream-retry", () => actualRetry);
});

const { handleResponses } = await import("../../src/server/responses");
const { handleResponsesCompact } = await import("../../src/server/responses/compact");
type HandleOptions = NonNullable<Parameters<typeof handleResponses>[3]>;

const TOKEN_ENDPOINT = "https://auth.x.ai/oauth/token";
const XAI_CHAT_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/chat/completions`;

let testDir = "";
let previousHome: string | undefined;
let previousCursorToken: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;
let originalNow: () => number;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

// A case that calls a handler directly never takes the writer lease startServer takes, so its
// dispatch is refused. Taken at the dispatch helpers rather than file-wide: the cases that do
// start a real server already own it, and this only ever adds a reference on the same home.
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };
// Every turn these helpers hand back. A row that asserts only on a status leaves a
// transformed body unread, and cancelling those before the listeners stop is what keeps a
// reader from settling against the journal after its lease is gone.
const pendingTurns: Response[] = [];
function trackTurn(response: Response): Response { pendingTurns.push(response); return response; }

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalNow = Date.now;
  previousHome = process.env.OPENCODEX_HOME;
  previousCursorToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-030-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-030-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  customRunTurn = undefined;
  customFetchResponse = undefined;
  customTransientResponse = undefined;
  customUsageEstimate = undefined;
  customCursorTransportFactory = undefined;
  clearRequestLogsForTests();
  clearResponseStateForTests();
  clearCursorThreadContinuityForTests();
});

afterEach(async () => {
  let responseStatePending = true;
  let cancelFailure: unknown;
  try {
    // Rows that assert only on a status leave a transformed body unread. Cancelling those first
    // means no reader is still attached when the listeners stop and the lease is given back. A
    // cancel that throws fails the case rather than being swallowed, but not before every other
    // turn and the listeners below have had their chance to close.
    for (const turn of pendingTurns.splice(0)) {
      if (turn.bodyUsed || !turn.body || turn.body.locked) continue;
      try { await turn.body.cancel(); }
      catch (error) { cancelFailure ??= error; }
    }
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    // After the listeners are stopped and the response state is flushed, both of which can
    // still account against the journal, and before the home below is removed.
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    clearResponseStateForTests();
    clearCursorThreadContinuityForTests();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCursorToken === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    else process.env.OPENCODEX_CURSOR_TEST_TOKEN = previousCursorToken;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
  }
  if (cancelFailure !== undefined) throw cancelFailure;
  expect(responseStatePending).toBe(false);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets, ...extra } },
  };
}

async function post(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  takeSpendHome();
  return trackTurn(await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, { model: "", provider: "" }, options));
}

let loggedRequestSequence = 0;

async function postLogged(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const start = Date.now();
  takeSpendHome();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, logCtx, options);
  loggedRequestSequence += 1;
  return trackTurn(responseWithDeferredRequestLog(
    response,
    `combo-test-${loggedRequestSequence}`,
    start,
    logCtx,
  ));
}

async function postModelLogged(
  config: OcxConfig,
  model: string,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const start = Date.now();
  takeSpendHome();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, input: "hello", stream: false, ...raw }),
  }), config, logCtx, options);
  loggedRequestSequence += 1;
  return trackTurn(responseWithDeferredRequestLog(
    response,
    `direct-test-${loggedRequestSequence}`,
    start,
    logCtx,
  ));
}

async function latestAttemptReceipts(config: OcxConfig) {
  const response = await management(config, "GET", "/api/logs?tail=1");
  const logs = logsFromApiBody(await response!.json());
  const usage = readUsageEntries();
  return { log: logs[0]!, usage: usage.at(-1)! };
}

async function expectCancelledAttemptReceipt(
  config: OcxConfig,
  expected: { provider: string; model: string; adapter: string },
): Promise<void> {
  const { log, usage } = await latestAttemptReceipts(config);
  for (const receipt of [log, usage]) {
    expect(receipt).toMatchObject({
      provider: "combo",
      model: "combo/free",
      attempts: [{ ...expected, status: 499 }],
    });
    expect((receipt.attempts as unknown[])).toHaveLength(1);
  }
}

interface SseFrame {
  event?: string;
  data: Record<string, unknown>;
}

async function collectSse(response: Response): Promise<SseFrame[]> {
  const text = await response.text();
  return text.split("\n\n").flatMap(block => {
    if (!block.trim()) return [];
    let event: string | undefined;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") return [];
    try {
      return [{ ...(event ? { event } : {}), data: JSON.parse(data) as Record<string, unknown> }];
    } catch {
      return [];
    }
  });
}

async function management(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(request, new URL(request.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function heldNativeTerminal(payload: Record<string, unknown>) {
  const release = deferred();
  const encoder = new TextEncoder();
  const upstream = serve(() => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta", item_id: "msg_late", output_index: 0,
        content_index: 0, delta: "already visible",
      })}\n\n`));
      await release.promise;
      controller.enqueue(encoder.encode(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  return { upstream, release: release.resolve };
}

// The .27 combo-advance contract: a combo that moved targets persists `comboTargetAdvanced`, which
// survives hydration, /api/logs and routing analytics. Split from server-combo-failover-e2e (size cap).
describe("server combo failover 030 activation matrix", () => {
  test("persists one logical A503 to B200 request with ordered physical usage", async () => {
    const a = serve(() => Response.json({
      error: { message: "overloaded" },
      usage: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
    }, { status: 503 }));
    const b = serve(() => chatSuccess("logged backup", "m2"));
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await postLogged(config);
    expect(response.status).toBe(200);
    await response.text();
    const { log, usage } = await latestAttemptReceipts(config);

    for (const receipt of [log, usage]) {
      expect(receipt).toMatchObject({
        provider: "combo",
        model: "combo/free",
        requestedModel: "combo/free",
        resolvedModel: "m2",
        comboTargetAdvanced: true,
        attempts: [
          { ordinal: 1, provider: "a", model: "m1", status: 503, usage: { inputTokens: 7, outputTokens: 1 } },
          { ordinal: 2, provider: "b", model: "m2", status: 200, usage: { inputTokens: 2, outputTokens: 1 } },
        ],
      });
    }

    clearRequestLogsForTests();
    expect(hydrateRequestLogsFromDisk()).toBe(1);
    const hydratedResponse = await management(config, "GET", "/api/logs?tail=1");
    const hydrated = logsFromApiBody(await hydratedResponse!.json());
    expect(hydrated[0]?.comboTargetAdvanced).toBe(true);
    expect((await computeRoutingAnalytics({})).comboFailoverRequests).toBe(1);
  });
});
