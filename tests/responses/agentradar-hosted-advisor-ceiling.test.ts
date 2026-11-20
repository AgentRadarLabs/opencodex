import { afterEach, beforeEach, expect, test } from "bun:test";
import { nativeMessagesDeclineReason } from "../../src/server/messages-native-eligibility";
import { configureSharedSpendLedger, resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
import type { RouteResult } from "../../src/router";
import type { OcxConfig } from "../../src/types";

// The hosted exact relay sends caller bytes as-is, so a hosted Advisor under a token spend ceiling
// must take the bridge, which withholds or refuses it (#8815). Without a ceiling it stays native.
const route = {
  providerName: "anth", modelId: "claude-x", routeKind: "direct", routeReason: "test",
  provider: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "ka" },
} as unknown as RouteResult;
const config = { port: 10100, defaultProvider: "anth", providers: { anth: route.provider } } as unknown as OcxConfig;
const declared = { tools: [{ type: "advisor_20260301", name: "advisor" }], messages: [{ role: "user", content: "hi" }] };
const replayed = { messages: [{ role: "assistant", content: [
  { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
  { type: "advisor_tool_result", tool_use_id: "srvtoolu_1", content: { type: "advisor_result", text: "x" } },
] }] };
let previous: string | undefined;

beforeEach(() => { previous = process.env.OPENCODEX_AGENTRADAR; process.env.OPENCODEX_AGENTRADAR = "1"; });
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previous;
  resetSharedSpendLedgerForTest();
});

test("without a spend ceiling the hosted Advisor keeps the exact native relay", () => {
  expect(nativeMessagesDeclineReason(route, declared, config)).toBeUndefined();
});

test("under a spend ceiling a declared or replayed hosted Advisor takes the bridge", () => {
  configureSharedSpendLedger({ root: {}, identity: {}, pool: { maxTokens: 1000 } });
  expect(nativeMessagesDeclineReason(route, declared, config)).toBe("bridge-only-policy");
  expect(nativeMessagesDeclineReason(route, replayed, config)).toBe("bridge-only-policy");
  expect(nativeMessagesDeclineReason(route, { messages: [{ role: "user", content: "hi" }] }, config)).toBeUndefined();
});
