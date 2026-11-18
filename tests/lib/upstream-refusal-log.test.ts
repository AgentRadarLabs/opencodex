import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  INBOUND_SIZE_LOG_THRESHOLD_BYTES,
  logOversizedInbound,
  logTranslationBufferLimit,
  logUpstreamRefusal,
  outgoingBodyBytes,
  refusalEnvelopeFields,
} from "../../src/lib/upstream-refusal-log";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";

// Provider answers copied byte for byte, never tidied:
// - Anthropic "Claude API errors" page (platform.claude.com/docs/en/api/errors), "Prefill not
//   supported" and "Error shapes" examples, read 2026-11-15 (the request id is the page's own).
// - OpenAI error-codes guide, "400 - Invalid service_tier argument", in OpenAI's standard envelope.
// - OpenCode Go 400 for `reasoning_effort: max`, recorded in devlog/_plan/260912_reasoning_metadata.
// - A staging gateway log line for an Anthropic 400, cut at 200 characters: a body that is not JSON.
const anthropicPrefill400 = `{"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill. The conversation must end with a user message."}}`;
const anthropicNotFound404 = `{"type":"error","error":{"type":"not_found_error","message":"The requested resource could not be found."},"request_id":"req_011CSHoEeqs5C35K2UUqR7Fy"}`;
const openaiServiceTier400 = `{"error":{"message":"Invalid \`service_tier\` argument: The requested service tier is not allowed for this project.","type":"invalid_request_error","param":"service_tier","code":null}}`;
const opencodeGoEffort400 = `{"param":"reasoning.effort","type":"invalid_request_error","message":"Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor."}`;
const cutNonJson400 = `Provider error 400: {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and k`;

const PROMPT_TEXT = "DISTINCTIVE-PROMPT-TEXT-7731";
// Shaped as a test sentinel so the privacy scan knows it is fake.
const API_KEY = "sk-test-9942distinctive";

let warnings: string[];
let restore: () => void;

beforeEach(() => {
  warnings = [];
  const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  const previous = process.env.OPENCODEX_AGENTRADAR;
  process.env.OPENCODEX_AGENTRADAR = "1";
  restore = () => {
    spy.mockRestore();
    if (previous === undefined) delete process.env.OPENCODEX_AGENTRADAR;
    else process.env.OPENCODEX_AGENTRADAR = previous;
  };
});
afterEach(() => restore());

function refusalLines(): string[] {
  return warnings.filter(line => line.startsWith("[upstream-refusal]"));
}

async function waitForRefusalLine(): Promise<string> {
  for (let i = 0; i < 100 && refusalLines().length === 0; i++) await Bun.sleep(10);
  expect(refusalLines()).toHaveLength(1);
  return refusalLines()[0]!;
}

/** One model call through the same wrapper every adapter and route uses, answered by `answer`. */
async function callThroughProviderFetch(answer: () => Response, opts: { model?: string; provider?: string } = {}) {
  const requestBody = JSON.stringify({ model: "ignored", messages: [{ role: "user", content: PROMPT_TEXT }] });
  const fetcher = providerFetch(
    { fetch: async () => answer() } as unknown as OcxProviderConfig,
    undefined,
    { providerName: opts.provider ?? "test-provider", modelId: opts.model ?? "test-model" },
  );
  const response = await fetcher("https://upstream.example.test/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: requestBody,
  });
  return { response, requestBody };
}

const json = (body: string, status: number) => () =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("upstream refusal log line", () => {
  test("a documented Anthropic 400 logs status, ids, type and size, and none of the message text", async () => {
    const { response, requestBody } = await callThroughProviderFetch(json(anthropicPrefill400, 400));
    const line = await waitForRefusalLine();
    expect(line).toBe(
      `[upstream-refusal] status=400 provider="test-provider" model="test-model" type="invalid_request_error"`
      + ` bytes=${Buffer.byteLength(requestBody)}`,
    );
    // Must-fail guard: the provider's message is free text that echoes client content.
    expect(line).not.toContain("prefill");
    expect(line).not.toContain("conversation must end");
    expect(line).not.toContain(PROMPT_TEXT);
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain("authorization");
    // The caller still gets the whole answer.
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(anthropicPrefill400);
  });

  test("a recorded 400 that names a parameter logs the parameter, not the message", async () => {
    const { requestBody } = await callThroughProviderFetch(json(opencodeGoEffort400, 400));
    const line = await waitForRefusalLine();
    expect(line).toContain(" status=400 ");
    expect(line).toContain(`type="invalid_request_error"`);
    expect(line).toContain(`param="reasoning.effort"`);
    expect(line).toContain(` bytes=${Buffer.byteLength(requestBody)}`);
    // No `code` in this envelope, so none is logged.
    expect(line).not.toContain("code=");
    expect(line).not.toContain("Muse Code subscription");
    expect(line).not.toContain("Console Go");
    expect(line).not.toContain("muse-spark");
  });

  test("a documented OpenAI 400 logs the parameter it names, not the message", async () => {
    await callThroughProviderFetch(json(openaiServiceTier400, 400));
    const line = await waitForRefusalLine();
    expect(line).toContain(`type="invalid_request_error" param="service_tier"`);
    // `code` is null in this envelope, so none is logged.
    expect(line).not.toContain("code=");
    expect(line).not.toContain("not allowed for this project");
  });

  test("envelope fields with a newline, a 200-character value or a key stay on one bounded line", async () => {
    const hostile = JSON.stringify({
      error: { type: "invalid_request_error\n[upstream-refusal] status=200", code: "c".repeat(200), param: API_KEY, message: PROMPT_TEXT },
    });
    await callThroughProviderFetch(json(hostile, 400));
    const line = await waitForRefusalLine();
    // One line: no newline survives, and a forged marker can only sit inside a quoted value.
    expect(line).not.toContain("\n");
    expect(line.startsWith("[upstream-refusal] status=400 ")).toBe(true);
    for (const field of ["type", "code", "param"]) {
      const value = new RegExp(`${field}="([^"]*)"`).exec(line)?.[1];
      expect(value).toBeDefined();
      expect(value!.length).toBeLessThanOrEqual(80);
    }
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(PROMPT_TEXT);
  });

  test("an envelope field that is not a short identifier is logged only as a hash", async () => {
    const echoed = JSON.stringify({ error: { type: "invalid_request_error", code: `${PROMPT_TEXT} please`, param: "req_011CSHoEeqs5C35K2UUqR7Fy" } });
    await callThroughProviderFetch(json(echoed, 400));
    const line = await waitForRefusalLine();
    const hash = (text: string) => `#${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
    expect(line).toContain(`type="invalid_request_error" code="${hash(`${PROMPT_TEXT} please`)}" param="${hash("req_011CSHoEeqs5C35K2UUqR7Fy")}"`);
    expect(line).not.toContain("DISTINCTIVE");
    expect(line).not.toContain("011CSHoE");
    expect(refusalEnvelopeFields(JSON.stringify({ error: { code: 400, param: "tools[3].function.name" } })))
      .toEqual({ code: "400", param: "tools[3].function.name" });
  });

  test("a documented 404 logs its type and never the request id that the body carries", async () => {
    await callThroughProviderFetch(json(anthropicNotFound404, 404));
    const line = await waitForRefusalLine();
    expect(line).toContain(" status=404 ");
    expect(line).toContain(`type="not_found_error"`);
    expect(line).not.toContain("req_011CSHoEeqs5C35K2UUqR7Fy");
    expect(line).not.toContain("could not be found");
  });

  test("a body that is not JSON logs status, ids and size only", async () => {
    const { requestBody } = await callThroughProviderFetch(json(cutNonJson400, 400));
    const line = await waitForRefusalLine();
    expect(line).toBe(
      `[upstream-refusal] status=400 provider="test-provider" model="test-model" bytes=${Buffer.byteLength(requestBody)}`,
    );
    expect(line).not.toContain("type=");
    expect(line).not.toContain("extra usage");
  });

  test("an empty refusal body still logs the line", async () => {
    await callThroughProviderFetch(() => new Response(null, { status: 413 }));
    const line = await waitForRefusalLine();
    expect(line).toContain(" status=413 ");
    expect(line).not.toContain("type=");
  });

  test("success, rotation statuses and server errors write no refusal line", async () => {
    await callThroughProviderFetch(json(anthropicPrefill400, 200));
    await callThroughProviderFetch(json(anthropicPrefill400, 401));
    await callThroughProviderFetch(json(anthropicPrefill400, 429));
    await callThroughProviderFetch(json(anthropicPrefill400, 503));
    await Bun.sleep(50);
    expect(refusalLines()).toEqual([]);
  });

  test("provider and model ids are redacted, bounded to 80 characters and cannot break the line", async () => {
    await callThroughProviderFetch(json(anthropicPrefill400, 400), {
      provider: `provider\nforged-line`,
      model: `${"m".repeat(200)}\n[upstream-refusal] status=200`,
    });
    const line = await waitForRefusalLine();
    expect(line).not.toContain("\n");
    expect(line.match(/\[upstream-refusal\]/g)).toHaveLength(1);
    const model = /model="([^"]*)"/.exec(line)?.[1] ?? "";
    expect(model.length).toBeLessThanOrEqual(80);
  });

  test("an unnamed provider and model log as dashes", async () => {
    const fetcher = providerFetch({ fetch: async () => json(anthropicPrefill400, 400)() } as unknown as OcxProviderConfig);
    await fetcher("https://upstream.example.test/v1/messages", { method: "POST", body: "{}" });
    const line = await waitForRefusalLine();
    expect(line).toContain(`provider="-" model="-"`);
  });
});

test("is silent unless the AgentRadar mode is on", async () => {
  delete process.env.OPENCODEX_AGENTRADAR;
  await callThroughProviderFetch(json(anthropicPrefill400, 400));
  logTranslationBufferLimit("request", { model: "m", limit: 1 });
  logOversizedInbound("/v1/messages", INBOUND_SIZE_LOG_THRESHOLD_BYTES + 1);
  await Bun.sleep(50);
  expect(warnings).toEqual([]);
});

describe("envelope parsing", () => {
  test("reads only type, code and param from the error object", () => {
    expect(refusalEnvelopeFields(anthropicPrefill400)).toEqual({ type: "invalid_request_error" });
    // A flat envelope: the fields sit at the top level, with no `error` object.
    expect(refusalEnvelopeFields(opencodeGoEffort400)).toEqual({ type: "invalid_request_error", param: "reasoning.effort" });
    expect(refusalEnvelopeFields(cutNonJson400)).toEqual({});
    expect(refusalEnvelopeFields("")).toEqual({});
    expect(refusalEnvelopeFields("null")).toEqual({});
    expect(refusalEnvelopeFields(`[]`)).toEqual({});
  });

  test("measures string, binary and blob bodies and leaves streams unmeasured", () => {
    expect(outgoingBodyBytes("héllo")).toBe(6);
    expect(outgoingBodyBytes(new Uint8Array(7))).toBe(7);
    expect(outgoingBodyBytes(new ArrayBuffer(9))).toBe(9);
    expect(outgoingBodyBytes(new Blob(["abcd"]))).toBe(4);
    expect(outgoingBodyBytes(new ReadableStream())).toBeUndefined();
    expect(outgoingBodyBytes(undefined)).toBeUndefined();
  });

  test("the line writer never prints an envelope field that was not given", () => {
    logUpstreamRefusal({ status: 400, provider: "p", model: "m" });
    expect(refusalLines()).toEqual([`[upstream-refusal] status=400 provider="p" model="m" bytes=-`]);
  });
});

describe("the fork's own size refusals", () => {
  test("a translation buffer refusal logs its size and cap, with no text", () => {
    logTranslationBufferLimit("request", { model: "test-model", bytes: 40_000_000, limit: 33_554_432 });
    expect(refusalLines()).toEqual([
      `[upstream-refusal] status=413 provider="-" model="test-model" code="translation_buffer_limit"`
      + ` where=request bytes=40000000 limit=33554432`,
    ]);
  });

  test("a translation buffer refusal without a known size logs a dash", () => {
    logTranslationBufferLimit("response", { model: "test-model", limit: 33_554_432 });
    expect(refusalLines()[0]).toContain(" where=response bytes=- limit=33554432");
  });

  test("an inbound request over 5 MB is logged with its path and size, a smaller one is not", () => {
    logOversizedInbound("/v1/messages", INBOUND_SIZE_LOG_THRESHOLD_BYTES);
    logOversizedInbound("/v1/messages", Number.NaN);
    expect(warnings).toEqual([]);
    logOversizedInbound("/v1/messages", INBOUND_SIZE_LOG_THRESHOLD_BYTES + 1);
    expect(warnings).toEqual([`[inbound-size] path="/v1/messages" bytes=${INBOUND_SIZE_LOG_THRESHOLD_BYTES + 1}`]);
  });
});
