// Ported from v2.65.0-vadymhimself.27 (45776369ce): Anthropic answers a spent plan whose extra
// usage is also spent with HTTP 400, not 429; one spent pool account must not fail the request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot, rotateAnthropicAccountOnRefusal } from "../../../src/oauth/anthropic-routing";
import { readAnthropicExtraUsageRefusal } from "../../../src/providers/anthropic-billing-refusal";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { startServer } from "../../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../../src/server/request-log";
import type { OcxConfig } from "../../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { fixturePath } from "../../helpers/repo-root";

const OUT_OF_EXTRA_USAGE = "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
// A recorded gateway log line cut at 200 chars; only the closing quote and braces the cut removed are added.
const RECORDED_THIRD_PARTY_LINE = readFileSync(fixturePath("anthropic-extra-usage-thirdparty-400.txt"), "utf8");
const RECORDED_THIRD_PARTY_BODY = `${RECORDED_THIRD_PARTY_LINE.slice("Provider error 400: ".length)}"}}`;
const ROLE_ORDER = "messages: roles must alternate between \"user\" and \"assistant\", but found multiple \"user\" roles in a row";
const envelope = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
const json400 = (body: string) => new Response(body, { status: 400, headers: { "content-type": "application/json" } });
const rotates = (body: string) => readAnthropicExtraUsageRefusal(json400(body));

function anthropicTextSse(text: string): Response {
  return new Response([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-pool-400-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-pool-400-"));
  process.env.OPENCODEX_HOME = testDir;
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearRequestLogsForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("extra-usage 400 evidence", () => {
  test("the recorded fixture is Anthropic's envelope, kept as recorded", () => {
    expect(RECORDED_THIRD_PARTY_LINE.startsWith("Provider error 400: {\"type\":\"error\"")).toBe(true);
    expect(JSON.parse(RECORDED_THIRD_PARTY_BODY)).toEqual({ type: "error", error: { type: "invalid_request_error",
      message: "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and k" } });
  });

  test("reading the evidence leaves the whole 400 body for the caller", async () => {
    const response = json400(envelope("invalid_request_error", ROLE_ORDER));
    expect(await readAnthropicExtraUsageRefusal(response)).toBe(false);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("roles must alternate");
  });

  test("both wordings rotate only inside Anthropic's envelope", async () => {
    expect(await rotates(RECORDED_THIRD_PARTY_BODY)).toBe(true);
    expect(await rotates(envelope("invalid_request_error", OUT_OF_EXTRA_USAGE))).toBe(true);
    expect(await rotates(envelope("invalid_request_error", "  You’re out of extra usage."))).toBe(true);
    expect(await rotates(envelope("invalid_request_error", "YOU'RE OUT OF EXTRA USAGE"))).toBe(true);
    expect(await rotates(OUT_OF_EXTRA_USAGE)).toBe(false);
    expect(await rotates(RECORDED_THIRD_PARTY_LINE)).toBe(false);
  });

  test("echoed client values, mid-message wording, wrong envelopes and other 400s never rotate", async () => {
    for (const value of ["toolu_insufficient_quota", "toolu_out_of_extra_usage", "You're out of extra usage", "Third-party apps now draw from your extra usage"]) {
      expect(await rotates(envelope("invalid_request_error", `tool_use ids were found without tool_result blocks: ${value}`))).toBe(false);
    }
    for (const message of [`messages.0.content.0.text: ${OUT_OF_EXTRA_USAGE}`, "Invalid model: you're out of extra usage", "x You're out of extra usage", ROLE_ORDER,
      "The prompt says: Third-party apps now draw from your extra usage, not your plan limits"]) {
      expect(await rotates(envelope("invalid_request_error", message))).toBe(false);
    }
    for (const body of [
      envelope("rate_limit_error", OUT_OF_EXTRA_USAGE), envelope("api_error", OUT_OF_EXTRA_USAGE),
      JSON.stringify({ error: { type: "invalid_request_error", message: OUT_OF_EXTRA_USAGE } }),
      JSON.stringify({ type: "invalid_request_error", error: { type: "invalid_request_error", message: OUT_OF_EXTRA_USAGE } }),
      JSON.stringify({ type: "error", message: OUT_OF_EXTRA_USAGE }),
      JSON.stringify({ type: "error", error: { message: OUT_OF_EXTRA_USAGE } }),
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: [OUT_OF_EXTRA_USAGE] } }),
      JSON.stringify([{ type: "error", error: { type: "invalid_request_error", message: OUT_OF_EXTRA_USAGE } }]), "",
    ]) expect(await rotates(body)).toBe(false);
    expect(await readAnthropicExtraUsageRefusal(new Response(envelope("invalid_request_error", OUT_OF_EXTRA_USAGE), { status: 500, headers: { "content-type": "application/json" } }))).toBe(false);
  });
});

describe("extra-usage 400 cooldown", () => {
  const config = { port: 0, defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
    anthropicAccountPool: { enabled: true, autoSwitchThreshold: 100 } } as OcxConfig;
  async function seedTwoAccounts() {
    for (const id of ["a", "b"]) await saveCredential("anthropic", { access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000, accountId: `uuid-${id}` });
    const set = getAccountSet("anthropic")!;
    const aId = set.accounts.find(account => account.credential.accountId === "uuid-a")!.id;
    await setActiveAccount("anthropic", aId);
    return { aId, bId: set.accounts.find(account => account.credential.accountId === "uuid-b")!.id };
  }

  test("without a reset it cools for ten minutes even while unified status reads allowed", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const now = 1_800_000_000_000;
    const allowed = new Headers({ "anthropic-ratelimit-unified-status": "allowed" });
    expect(rotateAnthropicAccountOnRefusal(config, aId, 400, null, "s", now, allowed, null, "claude-opus-5")).toBe(bId);
    expect(getAnthropicAccountHealthSnapshot(aId, now)?.cooldownUntil).toBe(now + 10 * 60_000);
  });

  test("a rejected window's reset sets the deadline", async () => {
    const { aId } = await seedTwoAccounts();
    const now = 1_800_000_000_000;
    const resetAt = now / 1000 + 3 * 3600;
    rotateAnthropicAccountOnRefusal(config, aId, 400, null, "s", now, new Headers({
      "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(resetAt) }), null, "claude-opus-5");
    expect(getAnthropicAccountHealthSnapshot(aId, now)?.cooldownUntil).toBe(resetAt * 1000);
  });
});

describe("routed /v1/messages through the Anthropic pool", () => {
  async function send(first: () => Response, providerExtra: object = {}, later: () => Response = () => anthropicTextSse("rotated")) {
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== "https://api.anthropic.com/v1/messages") throw new Error("unexpected fixture egress");
      authorizations.push(request.headers.get("authorization"));
      return authorizations.length === 1 ? first() : later();
    }) as typeof fetch;
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ anthropic: { activeAccountId: "account-a", accounts: ["a", "b"].map(id => ({
      id: `account-${id}`, credential: { access: `synthetic-access-${id}`, refresh: `synthetic-refresh-${id}`, expires: 9999999999999, accountId: `synthetic-account-${id}` },
    })) } }), { mode: 0o600 });
    // Hosted-gateway shape: no combo, the pool alone.
    saveConfig({ port: 0, defaultProvider: "anthropic",
      providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", ...providerExtra } },
      anthropicAccountPool: { enabled: true, autoSwitchThreshold: 100 } } as OcxConfig);
    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/messages", server.url), { method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "placeholder" },
        body: JSON.stringify({ model: "claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) });
      return { response, text: await response.text(), authorizations };
    } finally { await server.stop(true); }
  }

  test("an out-of-extra-usage 400 on account A retries on account B and cools A", async () => {
    const { response, text, authorizations } = await send(() => json400(envelope("invalid_request_error", OUT_OF_EXTRA_USAGE)));
    expect(response.status, text).toBe(200);
    expect(text).toContain("rotated");
    expect(authorizations).toEqual(["Bearer synthetic-access-a", "Bearer synthetic-access-b"]);
    const entry = getRequestLogEntries().findLast(row => row.surface === "claude");
    expect(entry?.attempts).toHaveLength(2);
    // Native Messages labels its pool quota hop as it labels a 429 hop; AgentRadar hosted gateways keep
    // .27's label from the Responses bridge, anthropic-oauth-429.
    const hopLabel = process.env.OPENCODEX_AGENTRADAR === "1" ? "anthropic-oauth-429" : "rate-limit-429";
    expect(entry?.attempts?.[1]).toMatchObject({ status: 200, recoveryKinds: [hopLabel] });
    expect(getAnthropicAccountHealthSnapshot("account-a")?.cooldownUntil).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  test("the recorded third-party-apps 400 rotates too", async () => {
    const { response, authorizations } = await send(() => json400(RECORDED_THIRD_PARTY_BODY));
    expect(response.status).toBe(200);
    expect(authorizations).toEqual(["Bearer synthetic-access-a", "Bearer synthetic-access-b"]);
  });

  test("a malformed-request or echoing 400 reaches the caller unchanged", async () => {
    for (const message of [ROLE_ORDER, "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_insufficient_quota"]) {
      clearAnthropicAccountPoolState();
      const { response, text, authorizations } = await send(() => json400(envelope("invalid_request_error", message)));
      expect(response.status).toBe(400);
      expect(text).not.toContain("rotated");
      expect(authorizations).toEqual(["Bearer synthetic-access-a"]);
      expect(getAnthropicAccountHealthSnapshot("account-a")).toBeNull();
    }
  });

  test("when every account is spent the ladder stops at the roster and returns the 400", async () => {
    const spent = () => json400(envelope("invalid_request_error", OUT_OF_EXTRA_USAGE));
    const { response, authorizations } = await send(spent, {}, spent);
    expect(response.status).toBe(400);
    expect(authorizations).toEqual(["Bearer synthetic-access-a", "Bearer synthetic-access-b"]);
  });
});
