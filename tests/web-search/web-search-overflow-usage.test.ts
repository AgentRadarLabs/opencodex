import { expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch } from "../../src/web-search/loop";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { OcxProviderConfig } from "../../src/types";
import { collectSse } from "../helpers/responses-conformance";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

test("usage-bearing translator overflow reaches request and wire without sidecar dispatch", async () => {
  const aggregate: unknown[] = [];
  const sidecarOutcomes: unknown[] = [];
  const adapter: ProviderAdapter = {
    name: "overflow",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async (_request, options) => {
      options?.onPhysicalSend?.({ ordinal: 1 });
      return new Response("wire", { status: 200 });
    },
    async *parseStream() {
      yield { type: "tool_call_start", id: "ws1", name: "web_search" };
      yield { type: "tool_call_delta", arguments: '{"q":"docs"}' };
      yield { type: "tool_call_end" };
      yield {
        type: "error",
        status: 502,
        errorType: "upstream_error",
        code: "translation_buffer_limit",
        message: "upstream translation buffer exceeded the safe limit",
        usage: { inputTokens: 7, outputTokens: 1 },
      };
    },
  };
  const response = await runWithWebSearch({
    parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
    adapter,
    forwardProvider,
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
    settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
    maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: usage => aggregate.push(usage),
    recordSidecarOutcome: outcome => sidecarOutcomes.push(outcome),
  });

  const frames = await collectSse(response.body!);
  const failed = frames.filter(frame => frame.event === "response.failed");
  expect(failed).toHaveLength(1);
  const failedResponse = failed[0]?.data.response as {
    error?: { code?: string };
    usage?: Record<string, unknown>;
  };
  expect(failedResponse.error?.code).toBe("translation_buffer_limit");
  expect(failedResponse.usage).toMatchObject({
    input_tokens: 7,
    output_tokens: 1,
    total_tokens: 8,
  });
  expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  expect(aggregate).toEqual([{ inputTokens: 7, outputTokens: 1 }]);
  expect(sidecarOutcomes).toEqual([]);
});
