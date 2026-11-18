// Ported from v2.65.0-vadymhimself.27 tests/server/terminal-guard-server.test.ts (8fb1bbbe79/e0b898adba):
// on an AgentRadar gateway a streamed terminal-guard re-ask moves off a refused Anthropic account. Assertions
// unchanged; the spend-ledger lease and the gateway flag are the only additions.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAnthropicAccountPoolState } from "../../src/oauth/anthropic-routing";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let releaseInheritedSpendHome: (() => void) | undefined;
// Taken per inherited-home dispatch because one row below installs a different home.
const takeInheritedSpendHome = (): void => { releaseInheritedSpendHome = acquireOwnedSpendHome(); };

const config = {
  port: 0,
  defaultProvider: "claude-se",
  providers: {
    "claude-se": {
      adapter: "anthropic",
      baseUrl: "https://example.test",
      apiKey: "sk-test",
    },
  },
} as unknown as OcxConfig;

/** Build an Anthropic SSE response from raw frames. */
function anthropicSse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const firstTurn = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我接下来会修改相关文件。"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const continuationTurn = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec_command","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** Build an OpenAI Chat Completions SSE response from raw frames. */
function chatSse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// A clean end-of-turn with only assistant text and no tool call — the suspicious
// no-tool completion the guard is meant to re-ask (mirrors firstTurn for openai-chat).
const chatFirstTurn = [
  'data: {"choices":[{"delta":{"content":"我接下来会修改相关文件。"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

// The continuation turn emits the tool call the model should have produced.
const chatContinuationTurn = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

function openAiChatConfig(terminalContinuationGuard?: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "glm-gw",
    providers: {
      "glm-gw": {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "key",
        defaultModel: "glm-5.2",
        models: ["glm-5.2"],
        ...(terminalContinuationGuard !== undefined ? { terminalContinuationGuard } : {}),
      },
    },
  } as unknown as OcxConfig;
}

describe("server terminal guard integration", () => {
  let originalFetch: typeof fetch;
  let calls: number;
  let requestBodies: Record<string, unknown>[];

  const previousAgentRadar = process.env.OPENCODEX_AGENTRADAR;
  beforeEach(() => {
    process.env.OPENCODEX_AGENTRADAR = "1";
    originalFetch = globalThis.fetch;
    calls = 0;
    requestBodies = [];
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return anthropicSse(calls === 1 ? firstTurn : continuationTurn);
    }) as typeof fetch;
  });

  afterEach(() => {
    // Released first so a failed row cannot carry its writer lease into the next case.
    releaseInheritedSpendHome?.();
    releaseInheritedSpendHome = undefined;
    globalThis.fetch = originalFetch;
    if (previousAgentRadar === undefined) delete process.env.OPENCODEX_AGENTRADAR;
    else process.env.OPENCODEX_AGENTRADAR = previousAgentRadar;
  });


  test("terminal-guard Anthropic account rotation opens a new physical attempt", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-terminal-anthropic-pool-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    // PORT: upstream ledger requires the spend-journal writer lease for direct handler dispatch.
    const releasePortSpendHome = acquireOwnedSpendHome();
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    try {
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        anthropic: {
          activeAccountId: "account-a",
          accounts: [
            {
              id: "account-a",
              credential: {
                access: "synthetic-access-a",
                refresh: "synthetic-refresh-a",
                expires: 9999999999999,
                accountId: "synthetic-account-a",
              },
            },
            {
              id: "account-b",
              credential: {
                access: "synthetic-access-b",
                refresh: "synthetic-refresh-b",
                expires: 9999999999999,
                accountId: "synthetic-account-b",
              },
            },
          ],
        },
      }), { mode: 0o600 });
      const poolConfig = {
        port: 0,
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            adapter: "anthropic",
            baseUrl: "https://example.test",
            authMode: "oauth",
          },
        },
        anthropicAccountPool: { enabled: true, autoSwitchThreshold: 100 },
      } as unknown as OcxConfig;
      const authorizations: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (authorizations.length === 1) return anthropicSse(firstTurn);
        if (authorizations.length === 2) {
          return Response.json(
            { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
            { status: 429, headers: { "retry-after": "30" } },
          );
        }
        return anthropicSse(continuationTurn);
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/claude-opus-4.8",
          input: "请检查这个问题并修复代码",
          stream: true,
          tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
        }),
      }), poolConfig, logCtx);

      expect(await response.text()).toContain("response.completed");
      expect(authorizations).toEqual([
        "Bearer synthetic-access-a",
        "Bearer synthetic-access-a",
        "Bearer synthetic-access-b",
      ]);
      expect(logCtx.attempts).toHaveLength(2);
      expect(logCtx.attempts?.[0]).toMatchObject({ status: 429, sendCount: 2 });
      expect(logCtx.attempts?.[1]).toMatchObject({
        sendCount: 1,
        recoveryKinds: ["anthropic-oauth-429"],
      });
      expect(logCtx.attempts?.[1]?.provider).not.toBe(logCtx.attempts?.[0]?.provider);
    } finally {
      releasePortSpendHome();
      clearAnthropicAccountPoolState();
      clearPoolRotationState();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Anthropic rotates on initial and terminal-guard continuation 403 denials", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-terminal-anthropic-denial-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    // PORT: upstream ledger requires the spend-journal writer lease for direct handler dispatch.
    const releasePortSpendHome = acquireOwnedSpendHome();
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    try {
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        anthropic: {
          activeAccountId: "account-a",
          accounts: [
            {
              id: "account-a",
              credential: {
                access: "synthetic-access-a",
                refresh: "synthetic-refresh-a",
                expires: 9999999999999,
                accountId: "synthetic-account-a",
              },
            },
            {
              id: "account-b",
              credential: {
                access: "synthetic-access-b",
                refresh: "synthetic-refresh-b",
                expires: 9999999999999,
                accountId: "synthetic-account-b",
              },
            },
            {
              id: "account-c",
              credential: {
                access: "synthetic-access-c",
                refresh: "synthetic-refresh-c",
                expires: 9999999999999,
                accountId: "synthetic-account-c",
              },
            },
          ],
        },
      }), { mode: 0o600 });
      const poolConfig = {
        port: 0,
        defaultProvider: "anthropic",
        providers: {
          anthropic: {
            adapter: "anthropic",
            baseUrl: "https://example.test",
            authMode: "oauth",
          },
        },
        anthropicAccountPool: { enabled: true, autoSwitchThreshold: 100 },
      } as unknown as OcxConfig;
      const sends: Array<{ authorization: string; body: string }> = [];
      globalThis.fetch = (async (_input, init) => {
        sends.push({
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          body: String(init?.body ?? ""),
        });
        if (sends.length === 2) return anthropicSse(firstTurn);
        if (sends.length === 1 || sends.length === 3) {
          return Response.json({
            type: "error",
            error: {
              type: "oauth_org_not_allowed",
              message: "Your organization has disabled Claude subscription access for Claude Code. Use an Anthropic API key instead, or ask your admin to enable access.",
            },
          }, { status: 403 });
        }
        return anthropicSse(continuationTurn);
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/claude-opus-4.8",
          input: "请检查这个问题并修复代码",
          stream: true,
          tools: [{ type: "function", name: "exec_command", description: "run a command", parameters: { type: "object" } }],
        }),
      }), poolConfig, logCtx);

      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("response.completed");
      expect(text).toContain("exec_command");
      expect(sends.map(send => send.authorization)).toEqual([
        "Bearer synthetic-access-a",
        "Bearer synthetic-access-b",
        "Bearer synthetic-access-b",
        "Bearer synthetic-access-c",
      ]);
      expect(sends[1]!.body).toBe(sends[0]!.body);
      expect(sends[3]!.body).toBe(sends[2]!.body);
      expect(logCtx.attempts).toHaveLength(3);
      expect(logCtx.attempts?.[0]).toMatchObject({ status: 403, sendCount: 1 });
      expect(logCtx.attempts?.[1]).toMatchObject({
        status: 403,
        sendCount: 2,
        recoveryKinds: [/* upstream roster name for .27 anthropic-oauth-403 */ "oauth-account-403"],
      });
      expect(logCtx.attempts?.[2]).toMatchObject({
        sendCount: 1,
        recoveryKinds: [/* upstream roster name for .27 anthropic-oauth-403 */ "oauth-account-403"],
      });
      const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
        anthropic: { accounts: Array<{ id: string; needsReauth?: boolean }> };
      };
      expect(auth.anthropic.accounts.find(account => account.id === "account-a")?.needsReauth).toBe(true);
      expect(auth.anthropic.accounts.find(account => account.id === "account-b")?.needsReauth).toBe(true);
      expect(auth.anthropic.accounts.find(account => account.id === "account-c")?.needsReauth).toBeUndefined();
    } finally {
      releasePortSpendHome();
      clearAnthropicAccountPoolState();
      clearPoolRotationState();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
