import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { agentRadarAccountPin, noteAgentRadarAccountDispatch, withAgentRadarServedAccount } from "../../src/lib/agentradar-account-pin";

const seen: { auth: string | null; internal: string[]; search: boolean }[] = [];
let refusal = 0;
let hold: (() => void) | undefined;
let entered: (() => void) | undefined;
function stream(events: [string, object][]) {
  return new Response(events.map(([type, body]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.method !== "POST") return Response.json({ data: [{ id: "claude-stub", type: "model" }, { id: "gpt-5.5", type: "model" }] });
  if (new URL(req.url).pathname.includes("codex/responses")) {
    seen.push({ auth: req.headers.get("authorization"), internal: [...req.headers.keys()].filter(key => key.startsWith("x-agentradar-")), search: false });
    const item = { type: "message", id: "msg_codex", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
    return stream([["response.created", { response: { id: "resp_codex", object: "response", status: "in_progress", output: [] } }],
      ["response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "ok" }],
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: { id: "resp_codex", object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]]);
  }
  const body = await req.json() as { tools?: { type?: string; name?: string }[]; messages?: unknown[] };
  const search = body.tools?.some(tool => tool.type === "web_search_20250305") ?? false;
  seen.push({ auth: req.headers.get("authorization"), internal: [...req.headers.keys()].filter(key => key.startsWith("x-agentradar-")), search });
  if (entered) { const notify = entered; entered = undefined; notify(); await new Promise<void>(resolve => { hold = resolve; }); }
  if (refusal === 400) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going." } }, { status: 400 });
  if (refusal) return Response.json({ type: "error", error: refusal === 403
    ? { type: "permission_error", message: "Your organization has disabled Claude subscription access for Claude Code. Use an Anthropic API key instead, or ask your admin to enable access." }
    : { type: "rate_limit_error", message: "fixture quota refusal" } }, { status: refusal, headers: refusal === 429
      ? { "retry-after": "30", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-5h-status": "rejected" } : {} });
  if (!search && body.tools?.some(tool => tool.name?.endsWith("web_search")) && !JSON.stringify(body.messages).includes("tool_result")) return stream([
    ["message_start", { message: { id: "msg_search", type: "message", role: "assistant", model: "claude-stub", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_search", name: body.tools.find(tool => tool.name?.endsWith("web_search"))!.name, input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "fixture query" }) } }],
    ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }], ["message_stop", {}],
  ]);
  return stream([
    ["message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-stub", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }], ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", {}],
  ]);
} });
const base = `http://127.0.0.1:${fake.port}`;
const homes: string[] = [];
const processes: Bun.Subprocess[] = [];
const pin = (provider = "claude", id = "A") => ({ "x-agentradar-account-provider": provider, "x-agentradar-account-id": id });
async function gateway(enabled = true, extra: object = {}) {
  const home = mkdtempSync(join(tmpdir(), "ocx-ar-port-")); homes.push(home);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(["acct1", "acct2"].map(id => [id, { credential: { accessToken: `fixture-codex-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `fixture-chatgpt-${id}` }, generation: 0 }]))), { mode: 0o600 });
  writeFileSync(join(home, "auth.json"), JSON.stringify({ anthropic: { activeAccountId: "B", selectionRevision: "fixture-selection", accounts: ["A", "B", "C"].map(id => ({ id,
    loginId: `fixture-login-${id}`, credential: { access: `fixture-${id}`, refresh: `fixture-refresh-${id}`, expires: Date.now() + 3_600_000 }, ...(id === "C" ? { needsReauth: true } : {}) })) } }), { mode: 0o600 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ hostname: "127.0.0.1", clientIntegrations: { codex: false }, defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: true, strategy: "round-robin", autoSwitchThreshold: 0 },
    providers: { anthropic: { adapter: "anthropic", baseUrl: base, authMode: "oauth", allowPrivateNetwork: true, models: ["claude-stub", "claude-blind"],
      modelCapabilities: { "claude-blind": { inputModalities: ["text"] } } }, other: { adapter: "openai-chat", baseUrl: base, apiKey: "fixture-other", models: ["other-stub"], allowPrivateNetwork: true } },
    ...extra }), { mode: 0o600 });
  // The canonical Codex host maps to the fake supplier; every other non-loopback request fails locally.
  writeFileSync(join(home, "network.ts"), `const original = globalThis.fetch; globalThis.fetch = ((input, init) => { const u = new URL(input instanceof Request ? input.url : String(input)); if (u.hostname === "chatgpt.com") return original(new Request(${JSON.stringify(base)} + u.pathname + u.search, new Request(input, init))); if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("non-loopback fixture request refused"); return original(input, init); }) as typeof fetch;`);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port; probe.stop(true);
  const proc = Bun.spawn([process.execPath, "--preload", join(home, "network.ts"), repoPath("src/cli/index.ts"), "start", "--port", String(port)], {
    cwd: repoPath(), env: { ...process.env, HOME: home, OPENCODEX_HOME: home, OPENCODEX_AGENTRADAR: enabled ? "1" : "0" }, stdout: "ignore", stderr: "pipe",
  }); processes.push(proc);
  let log = "";
  void (async () => { for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) log += new TextDecoder().decode(chunk); })();
  const url = `http://127.0.0.1:${port}`;
  let error: unknown;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) return { url, home, proc, log: () => log }; } catch (caught) { error = caught; }
    if (proc.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error(`fixture gateway failed: ${String(error)} ${log}`);
}
type Gateway = Awaited<ReturnType<typeof gateway>>;
async function call(gw: Gateway, headers: Record<string, string> = {}, body: object = {}, path = "/v1/messages") {
  const start = seen.length;
  const response = await fetch(`${gw.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify(path === "/v1/chat/completions" ? { model: "anthropic/claude-stub", messages: [{ role: "user", content: "hi" }], ...body }
      : { model: "claude-stub", max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...body }) });
  return { status: response.status, served: response.headers.get("x-agentradar-served-account-id"), text: await response.text(), sends: seen.slice(start) };
}
afterAll(async () => {
  hold?.();
  for (const proc of processes) proc.kill();
  await Promise.all(processes.map(proc => proc.exited));
  fake.stop(true);
  for (const home of homes) removeTreeWithRetry(home);
});

test("AgentRadar parsing and dispatch-only attribution stay opt-in", () => {
  const previous = process.env.OPENCODEX_AGENTRADAR;
  try {
    delete process.env.OPENCODEX_AGENTRADAR;
    expect(agentRadarAccountPin(new Headers(pin()))).toBeNull();
    expect(agentRadarAccountPin(new Headers())).toBeUndefined();
    process.env.OPENCODEX_AGENTRADAR = "1";
    expect(agentRadarAccountPin(new Headers(pin()))).toEqual({ provider: "claude", accountId: "A" });
    for (const headers of [pin("other"), pin("claude", "has space"), { "x-agentradar-account-id": "A" }]) expect(agentRadarAccountPin(new Headers(headers))).toBeNull();
    const context = {};
    expect(withAgentRadarServedAccount(new Response(), context).headers.has("x-agentradar-served-account-id")).toBe(false);
    noteAgentRadarAccountDispatch(context, "A");
    expect(withAgentRadarServedAccount(new Response(), context).headers.get("x-agentradar-served-account-id")).toBe("A");
  } finally { if (previous === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previous; }
});

test("real gateway pins both ingresses, refuses escapes and helpers, and never rotates a refused pin", async () => {
  const gw = await gateway(true, { visionSidecar: { backend: "routed", model: "anthropic/claude-stub" } });
  for (const path of ["/v1/messages", "/v1/chat/completions"]) {
    const result = await call(gw, { ...pin(), "x-api-key": "sk-ant-fixture-caller" }, {}, path);
    expect(result.status, result.text).toBe(200); expect(result.served).toBe("A");
    expect(result.sends.map(send => send.auth)).toEqual(["Bearer fixture-A"]);
    expect(result.sends.every(send => send.internal.length === 0)).toBe(true);
  }
  for (const headers of [pin("claude", "missing"), pin("claude", "C"), pin("grok"), pin("codex", "__main__"), pin("claude", "has space")]) {
    const result = await call(gw, headers); expect(result.status).toBeGreaterThanOrEqual(400); expect(result.sends).toHaveLength(0); expect(result.served).toBeNull();
  }
  for (const body of [{ model: "other/other-stub" }, { model: "claude-blind", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } }] }] }]) {
    const result = await call(gw, pin(), body); expect(result.status).toBeGreaterThanOrEqual(400); expect(result.sends).toHaveLength(0); expect(result.served).toBeNull();
  }
  const codexGateway = await gateway(true, { activeCodexAccountId: "acct2",
    codexAccounts: ["acct1", "acct2"].map(id => ({ id, email: `${id}@example.invalid`, isMain: false, chatgptAccountId: `fixture-chatgpt-${id}` })),
    providers: { anthropic: { adapter: "anthropic", baseUrl: base, authMode: "oauth", allowPrivateNetwork: true, models: ["claude-stub"] },
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } } });
  const codex = await call(codexGateway,{ ...pin("codex", "acct1"), authorization: "Bearer caller-must-not-forward", "chatgpt-account-id": "caller-account" }, { model: "openai/gpt-5.5" }, "/v1/chat/completions");
  expect(codex.status, `${codex.text}\n${codexGateway.log()}`).toBe(200); expect(codex.served).toBe("acct1");
  expect(codex.sends.map(send => send.auth)).toEqual(["Bearer fixture-codex-acct1"]);
  const unsupported = await call(gw, pin(), { model: "anthropic/claude-stub", input: "hi" }, "/v1/responses");
  expect(unsupported.status).toBe(400); expect(unsupported.sends).toHaveLength(0);
  const search = await call(gw, pin(), { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] });
  expect(search.status, search.text).toBe(200); expect(search.sends.some(send => send.search)).toBe(true);
  expect(new Set(search.sends.map(send => send.auth))).toEqual(new Set(["Bearer fixture-A"]));
  for (const status of [400, 403, 429]) {
    const isolated = await gateway(); refusal = status;
    try {
      const result = await call(isolated, pin()); expect(result.status, result.text).toBe(status);
      expect(result.sends.map(send => send.auth)).toEqual(["Bearer fixture-A"]); expect(result.served).toBe("A");
    } finally { refusal = 0; }
  }
  const disabled = await gateway(false);
  const refused = await call(disabled, pin()); expect(refused.status).toBe(400); expect(refused.sends).toHaveLength(0);
}, 45_000);

test("fresh and warm gateways agree on keyed hash seat independently of baseline and persisted affinity", async () => {
  const first = await gateway(); const second = await gateway();
  const session = "11111111-1111-4111-8111-111111111111";
  const expected = ["A", "B"].sort((a, b) => createHash("sha256").update(`${createHash("sha256").update(session).digest("hex").slice(0, 32)}\0${b}`).digest("hex").localeCompare(createHash("sha256").update(`${createHash("sha256").update(session).digest("hex").slice(0, 32)}\0${a}`).digest("hex")))[0];
  for (const gw of [first, second, first]) {
    const result = await call(gw, {}, { metadata: { user_id: JSON.stringify({ session_id: session, tk: crypto.randomUUID() }) } });
    expect(result.status, result.text).toBe(200); expect(result.served).toBe(expected);
  }
}, 30_000);
