// AgentRadar hosted gateways (.27): count_tokens for a canonical Anthropic target is Anthropic's own
// exact count. Ports the .27 claude-messages-endpoint count_tokens cases, plus the pin fix: a pinned
// request counts on its pinned account only, and an unpinned count commits no account selection.
import { afterEach, beforeEach, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installEndpointHooks, test, startServer, testDir, originalFetch } from "../helpers/claude-endpoint-lifetime";
import { clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { saveConfig } from "../../src/config";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

installEndpointHooks();
const previousHosted = process.env.OPENCODEX_AGENTRADAR;
beforeEach(() => { process.env.OPENCODEX_AGENTRADAR = "1"; });
afterEach(() => {
  if (previousHosted === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previousHosted;
});

function routedAnthropicNativeToolSource(): Record<string, any> {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "use the computer" }] }],
    tools: [{
      type: "computer_20250124",
      name: "computer",
      display_width_px: 1024,
      display_height_px: 768,
      input_schema: { type: "object" },
    }],
    context_management: { source_sentinel: true },
  };
}

function keyConfig(extra: Partial<OcxConfig>, providers: Record<string, string> = { target: "selected-key" }): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0],
    providers: Object.fromEntries(Object.entries(providers).map(([name, apiKey]) => [name, {
      adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey,
    }])),
    ...extra,
  } as OcxConfig;
}

function countRequest(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function writeAccounts(activeAccountId: string, ids: string[]): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    anthropic: {
      activeAccountId,
      accounts: ids.map(id => ({ id, credential: { access: `token-${id}`, refresh: "test-refresh-token", expires: 9999999999999 } })),
    },
  }), { mode: 0o600 });
}

const OAUTH_POOL_CONFIG = {
  port: 0,
  defaultProvider: "anthropic",
  providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
  anthropicAccountPool: { enabled: true, autoSwitchThreshold: 100 },
  claudeCode: { modelMap: { "claude-opus-5": "anthropic/claude-opus-5" } },
} as OcxConfig;

test("mapped combo count_tokens uses exact canonical Anthropic counting", async () => {
  const captured: Array<{ url: string; headers: Headers; body: Record<string, unknown>; keepalive?: boolean }> = [];
  const upstreamBody = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "count limit" } });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.anthropic.com/v1/messages/count_tokens") throw new Error(`unexpected egress ${request.url}`);
    captured.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown>, keepalive: init?.keepalive });
    return new Response(upstreamBody, { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } });
  };
  writeAccounts("count-account", ["count-account"]);
  saveConfig({
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        headers: { "anthropic-beta": "provider-beta,source-beta" },
      },
    },
    anthropicAccountPool: { enabled: true, autoSwitchThreshold: 100 },
    combos: { waterfall: { strategy: "failover", targets: [{ provider: "anthropic", model: "claude-opus-5" }] } },
    claudeCode: { modelMap: { "claude-opus-5": "combo/waterfall" } },
  } as OcxConfig);
  const source = {
    model: "claude-opus-5",
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "count this" }] }],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
    metadata: { user_id: "count-session" },
  };
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-admission",
        "x-api-key": "caller-admission",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "source-beta,duplicate-beta,source-beta",
        "user-agent": "source-user-agent",
        "x-arbitrary-source-header": "must-not-forward",
      },
      body: JSON.stringify(source),
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(upstreamBody);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body).toEqual(source);
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer token-count-account");
    expect(captured[0]!.headers.get("x-api-key")).toBeNull();
    expect(captured[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(captured[0]!.headers.get("anthropic-beta")).toBe(
      "source-beta,duplicate-beta,provider-beta,claude-code-20250219,oauth-2025-04-20",
    );
    expect(captured[0]!.headers.get("user-agent")).not.toBe("source-user-agent");
    expect(captured[0]!.headers.get("x-arbitrary-source-header")).toBeNull();
    expect(captured[0]!.headers.get("connection")).toBe("close");
    expect(captured[0]!.keepalive).toBe(false);
    expect(getRequestLogEntries()).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});

test("count_tokens applies generation source eligibility before picking a combo target", async () => {
  const captured: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.anthropic.com/v1/messages/count_tokens") throw new Error(`unexpected egress ${request.url}`);
    captured.push(await request.json() as Record<string, unknown>);
    return Response.json({ input_tokens: 123 });
  };
  const config = {
    port: 0,
    defaultProvider: "target",
    providers: {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "xai-test-key" },
      target: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "selected-key" },
    },
    combos: {
      "count-source-waterfall": {
        strategy: "failover",
        targets: [
          { provider: "xai", model: "grok-4-1-fast" },
          { provider: "target", model: "claude-opus-5" },
          { provider: "target", model: "claude-haiku-4-5" },
        ],
      },
    },
    claudeCode: { modelMap: { "claude-haiku-4-5": "combo/count-source-waterfall" } },
  } as OcxConfig;

  const response = await handleClaudeCountTokens(countRequest(routedAnthropicNativeToolSource()), config);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ input_tokens: 123 });
  expect(captured).toEqual([{ ...structuredClone(routedAnthropicNativeToolSource()), model: "claude-haiku-4-5" }]);
  expect(getRequestLogEntries()).toHaveLength(0);
});

test("count_tokens and following generation share a random combo target", async () => {
  // Direct physical dispatch needs the writer lease before the shared spend ledger.
  const releaseSpendHome = acquireOwnedSpendHome();
  try {
    const captured: Array<{ path: string; model: string }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json() as { model: string };
      const path = new URL(request.url).pathname;
      captured.push({ path, model: body.model });
      if (path === "/v1/messages/count_tokens") {
        return Response.json({ input_tokens: 123 });
      }
      if (path !== "/v1/messages") throw new Error(`unexpected egress ${request.url}`);
      return new Response([
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_random", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    };
    const config = {
      port: 0,
      defaultProvider: "first",
      providers: {
        first: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "first-key",
        },
        second: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "second-key",
        },
      },
      combos: {
        "count-random": {
          strategy: "random",
          targets: [
            { provider: "first", model: "claude-opus-5" },
            { provider: "second", model: "claude-haiku-4-5" },
          ],
        },
      },
      claudeCode: { modelMap: { "claude-opus-5": "combo/count-random" } },
    } as OcxConfig;
    const source = {
      model: "claude-opus-5",
      metadata: { user_id: "random-count-generation-session" },
      messages: [{ role: "user", content: "same request" }],
    };
    const originalRandom = Math.random;
    const draws = [0, 0.99, 0.99];
    Math.random = () => draws.shift() ?? 0.99;
    try {
      const count = await handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(source),
      }), config);
      expect(count.status).toBe(200);
      expect(await count.json()).toEqual({ input_tokens: 123 });

      const generation = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...source, max_tokens: 1024, stream: true }),
      }), config, {});
      expect(generation.status).toBe(200);
      expect(await generation.text()).toContain("message_stop");
      expect(captured.map(entry => entry.path)).toEqual([
        "/v1/messages/count_tokens",
        "/v1/messages",
      ]);
      expect(captured[1]!.model).toBe(captured[0]!.model);

      const changedSource = {
        ...source,
        metadata: { user_id: "random-count-generation-cooldown" },
        messages: [{ role: "user", content: "eligibility changes" }],
      };
      const changedCount = await handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changedSource),
      }), config);
      expect(changedCount.status).toBe(200);
      await changedCount.text();
      const countedModel = captured[2]!.model;
      const cooledProvider = countedModel === "claude-opus-5" ? "first" : "second";
      coolComboTarget("count-random", { provider: cooledProvider, model: countedModel }, { cooldownMs: 60_000 });
      try {
        const changedGeneration = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...changedSource, max_tokens: 1024, stream: true }),
        }), config, {});
        expect(changedGeneration.status).toBe(200);
        await changedGeneration.text();
        expect(captured[3]!.model).not.toBe(countedModel);
      } finally {
        clearComboTargetCooldowns("count-random");
      }
    } finally {
      Math.random = originalRandom;
    }
  } finally {
    releaseSpendHome();
  }
});

test("count_tokens enforces combo image policy before dispatch", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return Response.json({ input_tokens: 123 });
  };
  const config = keyConfig({
    combos: { "count-no-images": { strategy: "failover", imageInput: "disabled", targets: [{ provider: "target", model: "claude-opus-5" }] } },
    claudeCode: { modelMap: { "claude-opus-5": "combo/count-no-images" } },
  } as Partial<OcxConfig>);

  const response = await handleClaudeCountTokens(countRequest({
    model: "claude-opus-5",
    messages: [{
      role: "user",
      content: [{
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        },
      }],
    }],
  }), config);

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("does not accept image input");
  expect(sends).toBe(0);
  expect(getRequestLogEntries()).toHaveLength(0);
});

test("count_tokens skips cooled combo targets like generation", async () => {
  const capturedModels: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.anthropic.com/v1/messages/count_tokens") throw new Error(`unexpected egress ${request.url}`);
    capturedModels.push((await request.json() as { model: string }).model);
    return Response.json({ input_tokens: 321 });
  };
  const config = keyConfig({
    combos: {
      "count-cooldown": {
        strategy: "failover",
        targets: [{ provider: "first", model: "claude-opus-5" }, { provider: "backup", model: "claude-haiku-4-5" }],
      },
    },
    claudeCode: { modelMap: { "claude-haiku-4-5": "combo/count-cooldown" } },
  } as Partial<OcxConfig>, { first: "first-key", backup: "backup-key" });
  coolComboTarget("count-cooldown", { provider: "first", model: "claude-opus-5" }, { cooldownMs: 60_000 });
  try {
    const response = await handleClaudeCountTokens(countRequest({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "count this" }],
    }), config);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 321 });
    expect(capturedModels).toEqual(["claude-haiku-4-5"]);
    expect(getRequestLogEntries()).toHaveLength(0);
  } finally {
    clearComboTargetCooldowns("count-cooldown");
  }
});

test("mapped canonical count_tokens rejects translator overflow before dispatch", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    throw new Error("unexpected oversized count send");
  };
  writeAccounts("overflow-account", ["overflow-account"]);
  saveConfig(OAUTH_POOL_CONFIG);
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "x".repeat(16 * 1024 * 1024) }] }),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toMatch(/translation_buffer_limit/);
    expect(sends).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("mapped canonical count_tokens cancels its physical request", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  let physicalSignal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    physicalSignal = signal ?? null;
    resolveStarted();
    return await new Promise<Response>((_resolve, reject) => {
      if (!signal) return reject(new Error("missing physical abort signal"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const config = keyConfig({ claudeCode: { modelMap: { "claude-opus-5": "target/claude-opus-5" } } } as Partial<OcxConfig>);
  const client = new AbortController();
  const pending = handleClaudeCountTokens(countRequest({
    model: "claude-opus-5",
    messages: [{ role: "user", content: "count this" }],
  }, {}, client.signal), config);
  await started;
  client.abort(new DOMException("client closed", "AbortError"));
  expect((await pending).status).toBe(499);
  expect((physicalSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(getRequestLogEntries()).toHaveLength(0);
});

test("mapped noncanonical count_tokens remains local", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    throw new Error("unexpected noncanonical count send");
  };
  const config = {
    port: 0,
    defaultProvider: "target",
    providers: { target: { adapter: "anthropic", baseUrl: "https://compatible.example", authMode: "key", apiKey: "selected-key" } },
    claudeCode: { modelMap: { "claude-opus-5": "target/claude-opus-5" } },
  } as OcxConfig;
  const response = await handleClaudeCountTokens(countRequest({
    model: "claude-opus-5",
    messages: [{ role: "user", content: "count locally" }],
  }), config);
  expect(response.status).toBe(200);
  expect((await response.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  expect(sends).toBe(0);
});

test("incompatible canonical count_tokens fails before dispatch", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    throw new Error("unexpected incompatible count send");
  };
  const config = keyConfig({ claudeCode: { modelMap: { "claude-haiku-4-5": "target/claude-opus-5" } } } as Partial<OcxConfig>);
  const response = await handleClaudeCountTokens(countRequest(routedAnthropicNativeToolSource()), config);
  expect(response.status).toBe(400);
  expect(await response.text()).toMatch(/replayed exactly/);
  expect(sends).toBe(0);
  expect(getRequestLogEntries()).toHaveLength(0);
});

test("a pinned count_tokens counts on the pinned account only and commits nothing", async () => {
  const auths: Array<string | null> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.anthropic.com/v1/messages/count_tokens") throw new Error(`unexpected egress ${request.url}`);
    auths.push(request.headers.get("authorization"));
    return Response.json({ input_tokens: 77 });
  };
  writeAccounts("acct-a", ["acct-a", "acct-b"]);
  saveConfig(OAUTH_POOL_CONFIG);
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentradar-account-provider": "claude", "x-agentradar-account-id": "acct-b" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "count on b" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 77 });
    expect(auths).toEqual(["Bearer token-acct-b"]);
    expect(JSON.parse(readFileSync(join(testDir, "auth.json"), "utf8")).anthropic.activeAccountId).toBe("acct-a");
  } finally {
    await server.stop(true);
  }
});

test("a pinned count_tokens on an unknown account fails closed with no send", async () => {
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return Response.json({ input_tokens: 1 });
  };
  writeAccounts("acct-a", ["acct-a", "acct-b"]);
  saveConfig(OAUTH_POOL_CONFIG);
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentradar-account-provider": "claude", "x-agentradar-account-id": "acct-missing" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "count" }] }),
    });
    expect(response.status).toBe(401);
    expect(sends).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("an unpinned pool count_tokens selects like a dispatch without committing the selection", async () => {
  const auths: Array<string | null> = [];
  globalThis.fetch = async (input, init) => {
    auths.push(new Request(input, init).headers.get("authorization"));
    return Response.json({ input_tokens: 5 });
  };
  writeAccounts("acct-a", ["acct-a", "acct-b"]);
  saveConfig(OAUTH_POOL_CONFIG);
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "count" }] }),
    });
    expect(response.status).toBe(200);
    expect(auths).toHaveLength(1);
    expect(["Bearer token-acct-a", "Bearer token-acct-b"]).toContain(auths[0]!);
    expect(JSON.parse(readFileSync(join(testDir, "auth.json"), "utf8")).anthropic.activeAccountId).toBe("acct-a");
  } finally {
    await server.stop(true);
  }
});

test("off the hosted flag count_tokens keeps the local estimate", async () => {
  delete process.env.OPENCODEX_AGENTRADAR;
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return Response.json({ input_tokens: 1 });
  };
  const config = keyConfig({ claudeCode: { modelMap: { "claude-opus-5": "target/claude-opus-5" } } } as Partial<OcxConfig>);
  const response = await handleClaudeCountTokens(countRequest({ model: "claude-opus-5", messages: [{ role: "user", content: "estimate" }] }), config);
  expect(response.status).toBe(200);
  expect((await response.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  expect(sends).toBe(0);
});

test("off the hosted flag a count_tokens pin header is refused, as on /v1/messages", async () => {
  delete process.env.OPENCODEX_AGENTRADAR;
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return Response.json({ input_tokens: 1 });
  };
  const config = keyConfig({ claudeCode: { modelMap: { "claude-opus-5": "target/claude-opus-5" } } } as Partial<OcxConfig>);
  const response = await handleClaudeCountTokens(countRequest({ model: "claude-opus-5", messages: [{ role: "user", content: "pinned" }] },
    { "x-agentradar-account-provider": "claude", "x-agentradar-account-id": "acct-a" }), config);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("Invalid AgentRadar account pin");
  expect(sends).toBe(0);
});
