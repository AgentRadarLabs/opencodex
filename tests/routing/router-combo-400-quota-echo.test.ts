/**
 * A 400 is quota only by its fields, never by quota words anywhere in its text (Mars L1 on #25).
 *
 * Anthropic's validation 400s echo client values (tool ids, content) into `error.message`.
 * classifyError used to match quota phrases anywhere in a 400, so one crafted request read as a
 * spent account: `insufficient_quota` is a provider-scoped combo failure, which cools every target
 * of that provider for ten minutes. These tests drive the same steps the combo takes on an adapter
 * 400: the dispatch's client error, the combo's read of it, the hop decision and the cooldown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatErrorResponse } from "../../src/bridge";
import { adapterFailureFromEvent } from "../../src/bridge/internal";
import { advanceComboAfterFailure, clearComboTargetCooldowns, isComboTargetInCooldown, pickComboTarget } from "../../src/combos";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";
import {
  isModelHealthBlocked,
  recordSubagentQuotaFailureForThreadSpawn,
  resetSubagentModelFallbackStateForTests,
} from "../../src/codex/subagent-model-fallback";
import { classifyError, inferHttpStatusFromAdapterMessage, isRateLimitOrQuotaFailureMessage } from "../../src/lib/errors";
import { isPoolRotatableStatus } from "../../src/oauth/anthropic-pool-rotation";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { normalizeUpstreamErrorText } from "../../src/server/responses/core-errors";
import type { OcxConfig } from "../../src/types";

// The recorded third-party refusal (fixtures/external/anthropic/README.md): a gateway log line cut
// at 200 chars. The bytes after the log prefix are Anthropic's raw envelope; only the closing quote
// and braces the cut removed are added.
const RECORDED_THIRD_PARTY_LINE = readFileSync(
  join(import.meta.dir, "../../fixtures/external/anthropic/extra-usage-thirdparty-400.txt"),
  "utf8",
);
const RECORDED_THIRD_PARTY_BODY = `${RECORDED_THIRD_PARTY_LINE.slice("Provider error 400: ".length)}"}}`;

/**
 * NO REAL ECHO SAMPLE: no recorded Anthropic validation 400 exists in fixtures/external/ (or
 * anywhere in the workspace) yet. Until one is logged, the echo payload is the RECORDED envelope
 * above with only `error.message` replaced by the client-echoing validation text. Envelope keys,
 * `type` and `error.type` stay exactly as recorded.
 */
function recordedEnvelopeWithMessage(message: string): string {
  const recorded = JSON.parse(RECORDED_THIRD_PARTY_BODY) as { error: Record<string, unknown> };
  return JSON.stringify({ ...recorded, error: { ...recorded.error, message } });
}

// Client-chosen values echoed back: a tool_use id, and user text quoted in a content error.
const ECHOED_TOOL_ID = recordedEnvelopeWithMessage(
  "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_insufficient_quota. "
    + "Each `tool_use` block must have a corresponding `tool_result` block in the next message.",
);
const ECHOED_CONTENT = recordedEnvelopeWithMessage(
  "messages.3.content.0.text: unexpected value: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
);
const ECHOED_THIRD_PARTY = recordedEnvelopeWithMessage(
  "messages.3.content.0.text: Third-party apps now draw from your extra usage, not your plan limits. rate limit exceeded",
);

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "ka", models: ["opus", "sonnet"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "anthropic", model: "opus" },
          { provider: "anthropic", model: "sonnet" },
          { provider: "b", model: "m2" },
        ],
      },
    },
  } as OcxConfig;
}

/** The combo's handling of one adapter 400, as core-combo runs it. */
async function comboOn400(upstreamBody: string, now: number) {
  // adapter-dispatch: the client error for an upstream 400.
  const normalized = normalizeUpstreamErrorText(upstreamBody, "unknown error");
  return comboOnChild(formatErrorResponse(400, "upstream_error", `Provider error 400: ${normalized.safeText}`), now);
}

/** The combo's handling of an adapter terminal error event that carries only its message text. */
async function comboOnAdapterMessage(message: string, now: number) {
  const { httpStatus, error } = adapterFailureFromEvent({ type: "error", message });
  return comboOnChild(formatErrorResponse(httpStatus, error.type, error.message, { code: error.code }), now);
}

async function comboOnChild(child: Response, now: number) {
  const childStatus = child.status;
  const childError = (await child.clone().json() as { error: { type: string; code: string | null } }).error;
  // core-combo: read the child failure, decide, and cool only when it hops.
  const failure = await consumeComboFailure(child, undefined, now);
  const decision = comboFailureDecision(failure.response.status, failure.classificationText, { code: failure.upstreamCode });
  const scope = comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode });
  const cfg = config();
  const pick = pickComboTarget(cfg, "free", { now })!;
  expect(pick.target).toMatchObject({ provider: "anthropic", model: "opus" });
  if (decision === "hop") {
    advanceComboAfterFailure(cfg, pick, {
      now,
      cooldownScope: scope,
      retryAfter: failure.retryAfter,
      status: failure.response.status,
      code: failure.upstreamCode,
      message: failure.classificationText,
    });
  }
  const cooled = (model: string, at: number) => isComboTargetInCooldown("free", { provider: "anthropic", model }, at);
  return { childStatus, childError, decision, scope, cooled };
}

beforeEach(() => clearComboTargetCooldowns());
afterEach(() => clearComboTargetCooldowns());

describe("HTTP 400 quota classification is anchored to the provider's fields", () => {
  test("the recorded third-party refusal is still insufficient_quota, raw and wrapped", () => {
    for (const message of [RECORDED_THIRD_PARTY_BODY, `Provider error 400: ${RECORDED_THIRD_PARTY_BODY}`]) {
      expect(classifyError(400, "upstream_error", message)).toMatchObject({ type: "insufficient_quota", code: "insufficient_quota" });
    }
    // The cut log line itself is not a whole envelope: truncated JSON is never quota.
    expect(classifyError(400, "upstream_error", RECORDED_THIRD_PARTY_LINE).code).toBe("invalid_request_error");
  });

  test("MUST-FAIL: an echoed client value with quota or rate words is a plain invalid request", () => {
    for (const body of [ECHOED_TOOL_ID, ECHOED_CONTENT, ECHOED_THIRD_PARTY]) {
      for (const message of [body, `Provider error 400: ${body}`]) {
        expect(classifyError(400, "upstream_error", message)).toMatchObject({
          type: "invalid_request_error",
          code: "invalid_request_error",
        });
      }
    }
  });

  test("OpenAI/Codex insufficient_quota counts as a field, not as words in the message", () => {
    const field = JSON.stringify({ error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } });
    expect(classifyError(400, "upstream_error", `Provider error 400: ${field}`).code).toBe("insufficient_quota");
    const echoed = JSON.stringify({
      error: { message: "Invalid 'tools[0].name': 'insufficient_quota' exceeded your current quota", type: "invalid_request_error", code: "invalid_value" },
    });
    expect(classifyError(400, "upstream_error", `Provider error 400: ${echoed}`).code).toBe("invalid_request_error");
  });

  test("429 keeps its substring classification", () => {
    expect(classifyError(429, "upstream_error", `Provider error 429: ${ECHOED_TOOL_ID}`).code).toBe("insufficient_quota");
    expect(classifyError(429, "upstream_error", "Rate limit reached for model").code).toBe("rate_limit_exceeded");
  });
});

describe("combo cooldown on an Anthropic 400", () => {
  test("the recorded refusal hops and cools the whole provider for ten minutes", async () => {
    const now = 1_000_000;
    const result = await comboOn400(RECORDED_THIRD_PARTY_BODY, now);
    expect(result.childError).toMatchObject({ type: "insufficient_quota", code: "insufficient_quota" });
    expect(result.decision).toBe("hop");
    expect(result.scope).toBe("provider");
    expect(result.cooled("opus", now + 1)).toBe(true);
    expect(result.cooled("sonnet", now + 10 * 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", { provider: "b", model: "m2" }, now + 1)).toBe(false);
  });

  for (const [name, body] of [
    ["an echoed toolu_insufficient_quota tool id", ECHOED_TOOL_ID],
    ["echoed 'out of extra usage' user content", ECHOED_CONTENT],
    ["echoed third-party wording and rate words", ECHOED_THIRD_PARTY],
  ] as const) {
    test(`MUST-FAIL: ${name} stops and records no combo cooldown`, async () => {
      const now = 2_000_000;
      const result = await comboOn400(body, now);
      expect(result.childError).toMatchObject({ type: "invalid_request_error", code: "invalid_request_error" });
      expect(result.decision).toBe("stop");
      expect(result.scope).not.toBe("provider");
      expect(result.cooled("opus", now + 1)).toBe(false);
      expect(result.cooled("sonnet", now + 1)).toBe(false);
    });
  }
});

// The web-search/images loops and native chat report an upstream failure as adapter text,
// `Provider error <status>: <body>`, and the status is inferred back from that text.
const ECHOED_RATE_WORDS = recordedEnvelopeWithMessage(
  "messages.2.content.0.text: unexpected value: Rate limit reached, too many requests, throttling",
);

describe("an explicit Provider error status is not re-inferred from echoed words", () => {
  test("MUST-FAIL: a 400 echoing rate-limit words stays 400", () => {
    for (const message of [
      `Provider error 400: ${ECHOED_RATE_WORDS}`,
      // formatAnthropicErrorBody's `type: message` summary, as the loops write it.
      "Provider error 400: invalid_request_error: messages.2.content.0.text: rate limit, too many requests",
    ]) {
      expect(inferHttpStatusFromAdapterMessage(message)).toBe(400);
    }
  });

  test("an explicit 429 stays 429, and an explicit bare status is kept", () => {
    expect(inferHttpStatusFromAdapterMessage("Provider error 429: Number of request tokens has exceeded your rate limit")).toBe(429);
    expect(inferHttpStatusFromAdapterMessage("Provider error 429")).toBe(429);
    expect(inferHttpStatusFromAdapterMessage("Provider error 503: invalid upstream answer")).toBe(503);
  });

  test("a message without the prefix keeps keyword inference", () => {
    expect(inferHttpStatusFromAdapterMessage("Rate limit reached for requests")).toBe(429);
    expect(inferHttpStatusFromAdapterMessage("too many requests, invalid model")).toBe(429);
    expect(inferHttpStatusFromAdapterMessage("model not found")).toBe(400);
    expect(inferHttpStatusFromAdapterMessage("upstream request timed out")).toBe(504);
    // Not this proxy's exact prefix: inferred as before.
    expect(inferHttpStatusFromAdapterMessage("provider error 400: rate limit")).toBe(429);
    expect(inferHttpStatusFromAdapterMessage("Upstream said Provider error 400: rate limit")).toBe(429);
  });

  test("MUST-FAIL: the echoing 400 adapter error stops the combo with no cooldown", async () => {
    const now = 3_000_000;
    const result = await comboOnAdapterMessage(`Provider error 400: ${ECHOED_RATE_WORDS}`, now);
    expect(result.childStatus).toBe(400);
    expect(result.childError.code).toBe("invalid_request_error");
    expect(result.decision).toBe("stop");
    expect(result.cooled("opus", now + 1)).toBe(false);
    expect(result.cooled("sonnet", now + 1)).toBe(false);
  });

  test("an explicit 429 adapter error still hops and cools its target", async () => {
    const now = 4_000_000;
    const result = await comboOnAdapterMessage("Provider error 429: Rate limit reached for requests", now);
    expect(result.childStatus).toBe(429);
    expect(result.childError.code).toBe("rate_limit_exceeded");
    expect(result.decision).toBe("hop");
    expect(result.cooled("opus", now + 1)).toBe(true);
  });
});

// adapter-dispatch reports a failed thread-spawn turn to subagent model health as
// `Provider error <status>: <body>` (a 429 or 402 as the bare number).
describe("subagent model health reads an explicit Provider error status", () => {
  const SPAWN = new Headers({ "x-openai-subagent": "collab_spawn" });
  const MODEL = "kimi/k3";
  const subagentConfig = (): OcxConfig => ({
    port: 0,
    defaultProvider: "kimi",
    providers: { kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid", models: ["k3"] } },
  } as OcxConfig);
  const blockedAfter = (message: string | number): boolean => {
    resetSubagentModelFallbackStateForTests();
    const now = 5_000_000;
    recordSubagentQuotaFailureForThreadSpawn(SPAWN, MODEL, message, subagentConfig(), undefined, now);
    return isModelHealthBlocked(MODEL, subagentConfig(), undefined, now + 1);
  };
  afterEach(() => resetSubagentModelFallbackStateForTests());

  const ECHOED_USAGE_LIMIT = recordedEnvelopeWithMessage(
    "messages.0.content.0.text: unexpected value: usage limit reached, rate limit, too many requests",
  );

  test("MUST-FAIL: an echoed 400 does not mark the model unhealthy", () => {
    for (const body of [ECHOED_RATE_WORDS, ECHOED_TOOL_ID, ECHOED_CONTENT, ECHOED_USAGE_LIMIT]) {
      const message = `Provider error 400: ${body}`;
      expect(isRateLimitOrQuotaFailureMessage(message)).toBe(false);
      expect(blockedAfter(message)).toBe(false);
    }
  });

  test("the recorded extra-usage 400 and an explicit 429 still mark it unhealthy", () => {
    expect(blockedAfter(`Provider error 400: ${RECORDED_THIRD_PARTY_BODY}`)).toBe(true);
    expect(blockedAfter("Provider error 429: Rate limit reached for requests")).toBe(true);
    expect(blockedAfter("Provider error 429")).toBe(true);
    expect(blockedAfter(429)).toBe(true);
  });

  test("messages without the prefix behave as before", () => {
    expect(isRateLimitOrQuotaFailureMessage("Weekly usage limit reached")).toBe(true);
    expect(isRateLimitOrQuotaFailureMessage("Too Many Requests")).toBe(true);
    expect(isRateLimitOrQuotaFailureMessage(`messages.0: toolu_insufficient_quota`)).toBe(true);
    expect(isRateLimitOrQuotaFailureMessage("connection refused")).toBe(false);
    // A 5xx keeps the usage-limit cue: Codex reports a spent window as 502.
    expect(isRateLimitOrQuotaFailureMessage("Provider error 502: usage limit reached")).toBe(true);
  });
});

// Anthropic's spend-limit 400 (https://platform.claude.com/docs/en/api/errors and
// https://platform.claude.com/docs/en/api/rate-limits#setting-your-own-spend-limit): HTTP 400
// `invalid_request_error` whose message STARTS with "You have reached your specified API usage
// limits" (or "...specified workspace API usage limits"). NO RECORDED SAMPLE: the body is the
// recorded envelope above with only `error.message` replaced by the documented opening.
const SPEND_LIMIT = recordedEnvelopeWithMessage(
  "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
);
const WORKSPACE_SPEND_LIMIT = recordedEnvelopeWithMessage(
  "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
);
const ECHOED_SPEND_LIMIT = recordedEnvelopeWithMessage(
  "messages.0.content.0.text: unexpected value: You have reached your specified API usage limits",
);

describe("Anthropic spend-limit 400", () => {
  test("is insufficient_quota and cools the provider like the extra-usage refusal", async () => {
    for (const body of [SPEND_LIMIT, WORKSPACE_SPEND_LIMIT]) {
      expect(classifyError(400, "upstream_error", `Provider error 400: ${body}`).code).toBe("insufficient_quota");
      clearComboTargetCooldowns();
      const now = 6_000_000;
      const result = await comboOn400(body, now);
      expect(result.decision).toBe("hop");
      expect(result.scope).toBe("provider");
      expect(result.cooled("sonnet", now + 1)).toBe(true);
    }
  });

  test("the pool rotates on it too, through the same matcher", () => {
    expect(isPoolRotatableStatus(400, SPEND_LIMIT)).toBe("quota-400");
    expect(isPoolRotatableStatus(400, WORKSPACE_SPEND_LIMIT)).toBe("quota-400");
    expect(isPoolRotatableStatus(400, ECHOED_SPEND_LIMIT)).toBeNull();
  });

  test("echoed anywhere but the start it is a plain invalid request", () => {
    expect(classifyError(400, "upstream_error", `Provider error 400: ${ECHOED_SPEND_LIMIT}`).code).toBe("invalid_request_error");
  });
});

// Volcengine Ark (https://www.volcengine.com/docs/82379/1299023): HTTP 400, `error.code`
// "InvalidSubscription", "Coding Plan not subscribed or expired". NO RECORDED SAMPLE: code, type
// and message are the documented table row, in Ark's OpenAI-style `error` object.
const VOLCENGINE_INVALID_SUBSCRIPTION = JSON.stringify({
  error: {
    code: "InvalidSubscription",
    message: "Your account (2100000000) does not have a valid coding plan subscription, or your subscription has expired.",
    param: "",
    type: "Forbidden",
  },
});

describe("Volcengine InvalidSubscription 400", () => {
  test("the error.code field is insufficient_quota", () => {
    expect(classifyError(400, "upstream_error", `Provider error 400: ${VOLCENGINE_INVALID_SUBSCRIPTION}`).code).toBe("insufficient_quota");
  });

  test("guard: the word in a message, or another field, is not", () => {
    for (const body of [
      JSON.stringify({ error: { code: "InvalidParameter", message: "InvalidSubscription", param: "model", type: "BadRequest" } }),
      JSON.stringify({ error: { code: "InvalidParameter", message: "x", param: "InvalidSubscription", type: "BadRequest" } }),
      JSON.stringify({ code: "InvalidSubscription", error: { code: "InvalidParameter", message: "x" } }),
    ]) {
      expect(classifyError(400, "upstream_error", `Provider error 400: ${body}`).code).toBe("invalid_request_error");
    }
  });
});

describe("HTTP 422 gets the same field-only rule as 400", () => {
  const echoed = recordedEnvelopeWithMessage(
    "tools.0.name: unexpected value: insufficient_quota, rate limit, too many requests, usage limit reached",
  );

  test("MUST-FAIL: words in a 422 are no quota or rate verdict", () => {
    for (const message of [echoed, `Provider error 422: ${echoed}`]) {
      const classified = classifyError(422, "upstream_error", message);
      expect(classified.code).not.toBe("insufficient_quota");
      expect(classified.code).not.toBe("rate_limit_exceeded");
    }
    expect(isRateLimitOrQuotaFailureMessage(`Provider error 422: ${echoed}`)).toBe(false);
    expect(inferHttpStatusFromAdapterMessage(`Provider error 422: ${echoed}`)).toBe(422);
  });

  test("MUST-FAIL: an echoing 422 stops the combo with no cooldown", async () => {
    const now = 7_000_000;
    const result = await comboOnChild(
      formatErrorResponse(422, "upstream_error", `Provider error 422: ${echoed}`),
      now,
    );
    expect(result.decision).toBe("stop");
    expect(result.cooled("opus", now + 1)).toBe(false);
    expect(result.cooled("sonnet", now + 1)).toBe(false);
  });

  test("a 422 field verdict and the existing non-quota 422 behaviour stay", () => {
    const field = JSON.stringify({ error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } });
    expect(classifyError(422, "upstream_error", `Provider error 422: ${field}`).code).toBe("insufficient_quota");
    expect(comboFailureDecision(422, "invalid_api_key")).toBe("hop");
    expect(comboFailureDecision(422, "unprocessable entity")).toBe("stop");
  });
});

describe("the free-tier prompt cap on a 400 or 422 counts only as a field", () => {
  const echoed = recordedEnvelopeWithMessage(
    "messages.0.content.0.text: unexpected value: err_free_prompt_cap, longer than the free tier allows for a single request",
  );

  test("MUST-FAIL: echoed err_free_prompt_cap / free-tier words do not hop or cool the provider", () => {
    for (const status of [400, 422]) {
      for (const message of [echoed, `Provider error ${status}: ${echoed}`]) {
        expect(comboFailureDecision(status, message)).toBe("stop");
        expect(comboFailureCooldownScope(status, message)).not.toBe("provider");
      }
    }
  });

  test("the field still hops; other statuses keep the word match", () => {
    // The shape the combo end-to-end test sends for the free-tier refusal (`metadata.reason`).
    const field = JSON.stringify({ error: {
      message: "This prompt is longer than the free tier allows for a single request.",
      type: "invalid_request_error",
      metadata: { reason: "err_free_prompt_cap" },
    } });
    expect(comboFailureDecision(400, field)).toBe("hop");
    expect(comboFailureCooldownScope(400, field)).toBe("none");
    expect(comboFailureCooldownScope(422, JSON.stringify({ error: { code: "err_free_prompt_cap", message: "x" } }))).toBe("provider");
    expect(comboFailureCooldownScope(429, "err_free_prompt_cap")).toBe("provider");
    expect(comboFailureDecision(413, JSON.stringify({ detail: "err_free_prompt_cap: prompt exceeds this tier" }))).toBe("hop");
  });
});
