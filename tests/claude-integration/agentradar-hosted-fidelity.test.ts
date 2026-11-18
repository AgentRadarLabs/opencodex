/**
 * AgentRadar hosted contract (v2.65.0-vadymhimself.27 source replay): a canonical Anthropic route
 * receives the caller's Messages body as sent and the client receives Anthropic's bytes as sent,
 * pinned or not, whatever the rollout switches say. A translated hop drops thinking text, server
 * blocks, citations, pause_turn and stop_sequence; a TTL rewrite changes cache-write billing.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SSE = [
  'event:message_start\ndata:{"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":5,"cache_read_input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"t"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"RED"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"srvtoolu_x","name":"code_execution","input":{"code":"1"}}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"code_execution_tool_result","tool_use_id":"srvtoolu_x","content":{"type":"code_execution_result","stdout":"1","stderr":"","return_code":0,"content":[]}}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":4,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"héllo"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":4,"delta":{"type":"citations_delta","citation":{"type":"char_location","cited_text":"c","document_index":0,"start_char_index":0,"end_char_index":1}}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":4}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");
const JSON_BODY = ' {"id" : "msg_j", "type" : "message", "role" : "assistant", "model" : "claude-opus-5",\n'
  + ' "content" : [{"type":"text","text":"héllo","citations":[{"type":"char_location","cited_text":"c","document_index":0,"start_char_index":0,"end_char_index":1}]}],\n'
  + ' "stop_reason" : "stop_sequence", "stop_sequence" : "END", "usage" : {"input_tokens":2,"output_tokens":1}}\n';

const ERROR_BODY = ' {"type":"error","error":{"type":"rate_limit_error","message":"slow down"},"request_id":"req_x"}\n';

const SOURCE = {
  model: "anthropic/claude-opus-5",
  max_tokens: 2048,
  system: [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: "policy", cache_control: { type: "ephemeral" } },
  ],
  thinking: { type: "adaptive" },
  context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
  tools: [
    { type: "code_execution_20250825", name: "code_execution" },
    { name: "lookup", description: "d", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } },
  ],
  metadata: { user_id: "fixture-user" },
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
};
const BETA = "context-management-2025-06-27,code-execution-2025-08-25";

let home = "";
let sent: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
let status = 200;
let previousHome: string | undefined;
let previousHosted: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousHosted = process.env.OPENCODEX_AGENTRADAR;
  home = mkdtempSync(join(tmpdir(), "ocx-ar-fidelity-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_AGENTRADAR = "1";
  sent = [];
  status = 200;
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousHosted === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previousHosted;
  removeTreeWithRetry(home);
});

function config(authMode: "key" | "oauth"): OcxConfig {
  const fetch = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ headers: new Headers(init?.headers), body });
    if (status !== 200) return new Response(ERROR_BODY, { status, headers: {
      "content-type": "application/json", "retry-after": "17",
      "anthropic-organization-id": "org-fixture", "anthropic-ratelimit-unified-5h-utilization": "0.97", "request-id": "req_fixture",
    } });
    return body.stream === true
      ? new Response(SSE, { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON_BODY, { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const provider = {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode, models: ["claude-opus-5"], fetch,
    ...(authMode === "key" ? { apiKey: "fixture-key" } : {}),
  } as OcxProviderConfig;
  // No protocols.rollout: the hosted flag alone selects the native lane.
  // A key row needs its own name: the registry owns the `anthropic` row's OAuth auth mode.
  const name = authMode === "key" ? "anthropic-key" : "anthropic";
  const result = { port: 0, defaultProvider: name, providers: { [name]: provider } } as OcxConfig;
  saveConfig(result);
  return result;
}

async function send(cfg: OcxConfig, stream: boolean, headers: Record<string, string> = {}) {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": BETA, "x-api-key": "fixture-admission", ...headers },
    body: JSON.stringify({ ...SOURCE, model: `${cfg.defaultProvider}/claude-opus-5`, stream }),
  }), cfg, logCtx);
  return { response, text: await response.text(), logCtx };
}

async function seedTwo(): Promise<string[]> {
  for (const index of [0, 1]) {
    await saveCredential("anthropic", {
      access: `fixture-access-${index}`, refresh: `fixture-refresh-${index}`, expires: Date.now() + 3_600_000,
      accountId: `fixture-account-${index}`, source: "oauth",
    });
  }
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[1]!);
  forgetAnthropicFailoverQuorum();
  return ids;
}

function expectExactSource(body: Record<string, unknown>, stream: boolean): void {
  // Caller body unchanged but for the wire model: no TTL injection, context_management kept.
  expect(body).toEqual({ ...SOURCE, stream, model: "claude-opus-5" });
  expect(JSON.stringify(body)).not.toContain('"ttl"');
}

for (const stream of [true, false]) {
  test(`hosted unpinned key route relays caller and Anthropic bytes unchanged (stream=${stream})`, async () => {
    const { response, text, logCtx } = await send(config("key"), stream);
    expect(response.status).toBe(200);
    expect(text).toBe(stream ? SSE : JSON_BODY);
    // TTL-less breakpoints sent as is: the attempt records the 5-minute lifetime they really have.
    expect(logCtx.activeAttempt?.promptCacheTtlMs).toBe(300_000);
    expect(sent).toHaveLength(1);
    expectExactSource(sent[0]!.body, stream);
    expect(sent[0]!.headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
  });

  test(`hosted pinned OAuth turn serves exactly its account with exact bytes (stream=${stream})`, async () => {
    const ids = await seedTwo();
    const { response, text } = await send(config("oauth"), stream,
      { "x-agentradar-account-provider": "claude", "x-agentradar-account-id": ids[0]! });
    expect(response.status).toBe(200);
    expect(text).toBe(stream ? SSE : JSON_BODY);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer fixture-access-0");
    expectExactSource(sent[0]!.body, stream);
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(ids[1]);
  });
}

test("a hosted pinned 429 is relayed verbatim from the pinned account without rotating", async () => {
  const ids = await seedTwo();
  status = 429;
  const { response, text } = await send(config("oauth"), true,
    { "x-agentradar-account-provider": "claude", "x-agentradar-account-id": ids[0]! });
  expect(response.status).toBe(429);
  expect(text).toBe(ERROR_BODY);
  expect(response.headers.get("retry-after")).toBe("17");
  // As .27: only Content-Type and Retry-After travel; the pooled account's org and quota state do not.
  for (const name of ["anthropic-organization-id", "anthropic-ratelimit-unified-5h-utilization", "request-id"]) {
    expect(response.headers.get(name)).toBeNull();
  }
  expect(sent.map(row => row.headers.get("authorization"))).toEqual(["Bearer fixture-access-0"]);
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(ids[1]);
});

test("a 413 on an image turn is rebuilt once with only the images smaller (.27 image-413)", async () => {
  const onePx = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const png = await new Bun.Image(Buffer.from(onePx, "base64")).resize(1500, 1000).png().toBuffer();
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(png).toString("base64") },
    cache_control: { type: "ephemeral", ttl: "1h" } };
  const bodies: Array<Record<string, any>> = [];
  const cfg = config("key");
  (cfg.providers["anthropic-key"] as { fetch: typeof fetch }).fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? Response.json({ type: "error", error: { type: "request_too_large", message: "too large" } }, { status: 413 })
      : new Response(JSON_BODY, { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "fixture-admission" },
    body: JSON.stringify({ model: "anthropic-key/claude-opus-5", max_tokens: 128, stream: false,
      messages: [{ role: "user", content: [image, { type: "text", text: "look" }] }], context_management: { edits: [] } }),
  }), cfg, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(JSON_BODY);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.messages[0].content[0]).toEqual(image);
  const resized = bodies[1]!.messages[0].content[0];
  expect(resized.source.media_type).toBe("image/jpeg");
  expect(resized.cache_control).toEqual(image.cache_control);
  const expected = structuredClone(bodies[0]!);
  expected.messages[0].content[0] = resized;
  expect(bodies[1]).toEqual(expected);
});

test("a hosted combo skips a model-changing target for typed tools and replays exactly on the matching one", async () => {
  const cfg = config("key");
  const provider = cfg.providers["anthropic-key"]!;
  provider.models = ["claude-opus-5", "claude-haiku-4-5"];
  cfg.combos = { waterfall: { strategy: "failover", targets: [
    { provider: "anthropic-key", model: "claude-opus-5" }, { provider: "anthropic-key", model: "claude-haiku-4-5" },
  ] } };
  cfg.claudeCode = { modelMap: { "claude-haiku-4-5": "combo/waterfall" } };
  saveConfig(cfg);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": BETA, "x-api-key": "fixture-admission" },
    body: JSON.stringify({ ...SOURCE, model: "claude-haiku-4-5", stream: true }),
  }), cfg, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(SSE);
  expect(sent.map(row => row.body.model)).toEqual(["claude-haiku-4-5"]);
  expect(sent[0]!.body).toEqual({ ...SOURCE, model: "claude-haiku-4-5", stream: true });
});

test("a hosted combo named directly by its alias carries typed tools to its first canonical target", async () => {
  const cfg = config("key");
  cfg.combos = { waterfall: { strategy: "failover", targets: [{ provider: "anthropic-key", model: "claude-opus-5" }] } };
  saveConfig(cfg);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": BETA, "x-api-key": "fixture-admission" },
    body: JSON.stringify({ ...SOURCE, model: "combo/waterfall", stream: true }),
  }), cfg, { model: "", provider: "" });
  // .27 exempted combo aliases: the caller chose no model to preserve, so typed tools are no refusal.
  expect(response.status).toBe(200);
  await response.text();
  expect(sent.map(row => row.body.model)).toEqual(["claude-opus-5"]);
});

test("a hosted combo never sends typed web_fetch to an Anthropic-compatible third party", async () => {
  const cfg = config("key");
  cfg.providers["anthropic-key"]!.baseUrl = "https://compat.example.com";
  cfg.combos = { waterfall: { strategy: "failover", targets: [{ provider: "anthropic-key", model: "claude-opus-5" }] } };
  saveConfig(cfg);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/waterfall", max_tokens: 64, stream: true,
      messages: [{ role: "user", content: "fetch this" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }, { type: "web_fetch_20250910", name: "web_fetch" }] }),
  }), cfg, { model: "", provider: "" });
  expect(response.status).toBe(400);
  await response.text();
  expect(sent).toHaveLength(0);
});

test("a hosted combo no target can carry refuses MCP servers with a 400 and no send", async () => {
  const cfg = config("key");
  cfg.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "k",
    fetch: (async () => { throw new Error("unexpected send"); }) as typeof fetch } as OcxProviderConfig;
  cfg.combos = { exact: { strategy: "failover", targets: [{ provider: "xai", model: "grok-4-1-fast" }] } };
  cfg.claudeCode = { modelMap: { "claude-haiku-4-5": "combo/exact" } };
  saveConfig(cfg);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "fixture-admission" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
      mcp_servers: [{ type: "url", name: "docs", url: "https://mcp.example.test" }] }),
  }), cfg, { model: "", provider: "" });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("require exact canonical Anthropic Messages replay");
  expect(sent).toHaveLength(0);
});
