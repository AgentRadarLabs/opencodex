/**
 * AgentRadar hosted contract for the Anthropic Messages relay tap, ported from
 * v2.65.0-vadymhimself.27 tests/claude-integration/claude-messages-endpoint.test.ts (A0b-A0f).
 * Under OPENCODEX_AGENTRADAR=1 the tap relays one validated frame per pull, stops at the first
 * terminal, records a root error as failed, and fails a malformed frame before it reaches the
 * client. Adapted assertions are marked "upstream:"; everything else is the .27 text.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RequestLogContext } from "../../src/server/request-log";
import { tapAnthropicSseForLog } from "../../src/server/claude-messages";

let previousHosted: string | undefined;
beforeEach(() => {
  previousHosted = process.env.OPENCODEX_AGENTRADAR;
  process.env.OPENCODEX_AGENTRADAR = "1";
});
afterEach(() => {
  if (previousHosted === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previousHosted;
});

const sseEncoder = new TextEncoder();

function spyFinalize() {
  const calls: Array<{ status: number; closeReason: string }> = [];
  return {
    calls,
    finalize: (status: number, meta: { closeReason: string }) => calls.push({ status, closeReason: meta.closeReason }),
  };
}
function freshLogCtx(): RequestLogContext {
  return { model: "claude-test", provider: "anthropic-native" };
}

const MESSAGE_START_FRAME = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n';

const MESSAGE_STOP_FRAME = 'event:message_stop\ndata:{"type":"message_stop"}\n\n';
const ROOT_ERROR_FRAME = 'event:error\ndata:{"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
test("A0b: truncated Anthropic SSE preserves prior bytes, records inclusive usage, and appends adapter_eof", async () => {
  const prefix = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":5,"cache_read_input_tokens":7}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  ].join("");
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode(prefix));
      controller.close();
    },
  });
  const ctx = freshLogCtx();
  const calls: Array<{ status: number; meta: unknown }> = [];
  const tap = tapAnthropicSseForLog(
    upstream,
    ctx,
    (status, meta) => calls.push({ status, meta }),
    { stallMs: 5_000, maxBytes: 0 },
    // upstream: the tap's fifth parameter is the frame context; first output is recorded by the lane.
  );
  const text = await new Response(tap).text();

  expect(text.startsWith(prefix)).toBe(true);
  // upstream: its own EOF sentence, logged as a failed turn rather than an incomplete one.
  expect(text).toContain("anthropic passthrough upstream stream ended before message_stop");
  expect(ctx.usage).toEqual({
    inputTokens: 15,
    outputTokens: 0,
    cachedInputTokens: 7,
    cacheReadInputTokens: 7,
    cacheCreationInputTokens: 5,
  });
  expect(calls).toEqual([{
    status: 502,
    meta: { closeReason: "terminal", terminalStatus: "failed" },
  }]);
});

test("A0c: Anthropic root error is relayed unchanged and recorded failed", async () => {
  const frame = 'event:error\ndata:{"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode(frame));
      controller.close();
    },
  });
  const calls: Array<{ status: number; meta: unknown }> = [];
  const body = await new Response(tapAnthropicSseForLog(
    upstream,
    freshLogCtx(),
    (status, meta) => calls.push({ status, meta }),
    { stallMs: 5_000, maxBytes: 0 },
  )).text();

  expect(body).toBe(frame);
  expect(calls).toEqual([{
    status: 502,
    meta: { closeReason: "terminal", terminalStatus: "failed" },
  }]);
});

test.each([
  {
    name: "message_stop then error in one read",
    chunks: [MESSAGE_STOP_FRAME + ROOT_ERROR_FRAME],
    expectedBody: MESSAGE_STOP_FRAME,
    expectedStatus: 200,
    expectedTerminal: "completed",
  },
  {
    name: "message_stop then error across reads",
    chunks: [MESSAGE_STOP_FRAME, ROOT_ERROR_FRAME],
    expectedBody: MESSAGE_STOP_FRAME,
    expectedStatus: 200,
    expectedTerminal: "completed",
  },
  {
    name: "error then message_stop in one read",
    chunks: [ROOT_ERROR_FRAME + MESSAGE_STOP_FRAME],
    expectedBody: ROOT_ERROR_FRAME,
    expectedStatus: 502,
    expectedTerminal: "failed",
  },
])("A0c terminal boundary: $name", async ({
  chunks,
  expectedBody,
  expectedStatus,
  expectedTerminal,
}) => {
  const pending = [...chunks];
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = pending.shift();
      if (chunk !== undefined) controller.enqueue(sseEncoder.encode(chunk));
      else controller.close();
    },
  });
  const calls: Array<{ status: number; meta: unknown }> = [];
  const body = await new Response(tapAnthropicSseForLog(
    upstream,
    freshLogCtx(),
    (status, meta) => calls.push({ status, meta }),
    { stallMs: 5_000, maxBytes: 0 },
  )).text();

  expect(body).toBe(expectedBody);
  expect(calls).toEqual([{
    status: expectedStatus,
    meta: { closeReason: "terminal", terminalStatus: expectedTerminal },
  }]);
});

test("A0d: one large upstream read relays at most one validated frame per pull", async () => {
  const frame = `data: {"type":"content_block_delta","padding":"${"x".repeat(2_048)}"}\n\n`;
  const chunk = sseEncoder.encode(frame.repeat(2_049) + MESSAGE_STOP_FRAME);
  expect(chunk.byteLength).toBeGreaterThan(4 * 1024 * 1024);
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const { calls, finalize } = spyFinalize();
  const reader = tapAnthropicSseForLog(
    upstream,
    freshLogCtx(),
    finalize,
    { stallMs: 5_000, maxBytes: 0 },
  ).getReader();

  try {
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe(frame);
    expect(calls).toEqual([]);
  } finally {
    await reader.cancel();
  }
});

test("A0e: Anthropic reader rejection appends one failed error terminal", async () => {
  let pull = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pull++ === 0) controller.enqueue(sseEncoder.encode(MESSAGE_START_FRAME));
      else controller.error(new Error("wire broke"));
    },
  });
  const calls: Array<{ status: number; meta: unknown }> = [];
  const body = await new Response(tapAnthropicSseForLog(
    upstream,
    freshLogCtx(),
    (status, meta) => calls.push({ status, meta }),
    { stallMs: 5_000, maxBytes: 0 },
  )).text();

  expect(body.startsWith(MESSAGE_START_FRAME)).toBe(true);
  // upstream: its own reset sentence.
  expect(body).toContain("anthropic passthrough upstream stream failed: wire broke");
  expect((body.match(/event: error/g) ?? [])).toHaveLength(1);
  expect(calls).toEqual([{
    status: 502,
    meta: { closeReason: "terminal", terminalStatus: "failed" },
  }]);
});

test("A0f: malformed Anthropic SSE records fail before relay or later terminal", async () => {
  const invalidUtf8 = Uint8Array.from([
    ...sseEncoder.encode("data: \"bad_utf8_"),
    0xc3,
    0x28,
    ...sseEncoder.encode("\"\n\n"),
  ]);
  const cases = [
    { name: "invalid UTF-8", frame: invalidUtf8, marker: "bad_utf8_" },
    { name: "malformed JSON", frame: sseEncoder.encode("data: {bad_json_marker\n\n"), marker: "bad_json_marker" },
    { name: "scalar JSON", frame: sseEncoder.encode('data: "bad_scalar_marker"\n\n'), marker: "bad_scalar_marker" },
    { name: "array JSON", frame: sseEncoder.encode('data: ["bad_array_marker"]\n\n'), marker: "bad_array_marker" },
    { name: "Responses sentinel", frame: sseEncoder.encode("data: [DONE]\n\n"), marker: "[DONE]" },
  ];

  for (const testCase of cases) {
    let pulled = false;
    let cancels = 0;
    const chunk = Uint8Array.from([
      ...sseEncoder.encode(MESSAGE_START_FRAME),
      ...testCase.frame,
      ...sseEncoder.encode(MESSAGE_STOP_FRAME),
    ]);
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled) return;
        pulled = true;
        controller.enqueue(chunk);
      },
      cancel() { cancels += 1; },
    }, { highWaterMark: 0 });
    const calls: Array<{ status: number; meta: unknown }> = [];
    const body = await new Response(tapAnthropicSseForLog(
      upstream,
      freshLogCtx(),
      (status, meta) => calls.push({ status, meta }),
      { stallMs: 5_000, maxBytes: 0 },
    )).text();

    expect(body.startsWith(MESSAGE_START_FRAME), testCase.name).toBe(true);
    expect(body, testCase.name).not.toContain(testCase.marker);
    expect(body, testCase.name).not.toContain("message_stop");
    expect(body.match(/event: error/g) ?? [], testCase.name).toHaveLength(1);
    expect(cancels, testCase.name).toBe(1);
    expect(calls, testCase.name).toEqual([{
      status: 502,
      meta: { closeReason: "terminal", terminalStatus: "failed" },
    }]);
  }
});

test("A0g: a local error presentation keeps its identity through the strict re-framing", async () => {
  const { MessagesSseFrameContext } = await import("../../src/lib/messages-sse-error-presentation");
  const { createMessagesSseErrorFilter } = await import("../../src/server/messages-sse-error-filter");
  const { SSE_SENTINEL, sseFrame } = await import("../helpers/messages-sse-cases");
  const frames = new MessagesSseFrameContext();
  // An upstream frame echoing the caller's prompt or a key, marked for replacement by the client filter.
  const bytes = new TextEncoder().encode(sseFrame("message_start", { type: "message_start", message: { model: "fixed", usage: {} }, request_id: SSE_SENTINEL }));
  frames.register(bytes, { echoRenamedError: true });
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const text = await new Response(tapAnthropicSseForLog(source, {} as RequestLogContext, () => {}, { stallMs: 0, maxBytes: 0 },
    frames, createMessagesSseErrorFilter(frames))).text();
  expect(text).not.toContain(SSE_SENTINEL);
  expect(text.startsWith('event: message_start\ndata: {"type":"error"')).toBe(true);
});
