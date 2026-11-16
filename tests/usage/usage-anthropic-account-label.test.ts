// The usage ledger names the Anthropic subscription account that served each request, masked, on
// every path: plain active account (pool off, no pin), AgentRadar pin, pool pick, and the combo
// ladder that carries nearly all hosted traffic -- including a failover inside the combo where a
// different account serves. A real OCX process serves fake credentials against a loopback fake
// provider and the assertions read the `usage.jsonl` it writes. No real tokens, no real provider.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
/** The contract, computed independently of src: `p` + the first 6 hex of sha256(account id). */
const label = (accountId: string) => `p${createHash("sha256").update(accountId).digest("hex").slice(0, 6)}`;

const ids = ["acct-alpha-7f3e", "acct-bravo-91c2", "acct-charlie-0d4b", "acct-delta-5a6e"];
const token = (id: string) => `synthetic-access-${id}`;
const accountOf = (auth: string | null) => ids.find(id => auth === `Bearer ${token(id)}`);

const sent: Array<string | null> = [];
const limited = new Set<string>();
const enc = new TextEncoder();
const sse = (events: [string, object][]) => new Response(new ReadableStream({
  start(c) { for (const [type, data] of events) c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)); c.close(); },
}), { headers: { "content-type": "text/event-stream" } });
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/messages") return Response.json({ error: "not found" }, { status: 404 });
    const streamed = (JSON.parse(await req.text()) as { stream?: unknown }).stream === true;
    const auth = req.headers.get("authorization");
    sent.push(auth);
    if (auth && limited.has(auth)) {
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        { status: 429, headers: { "retry-after": "30" } });
    }
    if (!streamed) {
      return Response.json({ id: "msg_fake", type: "message", role: "assistant", model: "claude-stub",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 } });
    }
    return sse([
      ["message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-stub", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ["message_stop", {}],
    ]);
  },
});
const FAKE = `http://127.0.0.1:${fake.port}`;
const homes: string[] = [];

async function startOcx(activeAccountId: string, config: object) {
  const home = mkdtempSync(join(tmpdir(), "ocx-ledger-acct-"));
  homes.push(home);
  mkdirSync(`${home}/.codex`, { mode: 0o700 });
  writeFileSync(`${home}/auth.json`, JSON.stringify({ anthropic: { activeAccountId, accounts: ids.map(id => ({
    id, credential: { access: token(id), refresh: `refresh-${id}`, expires: 9999999999999, email: `${id}@example.invalid` },
  })) } }), { mode: 0o600 });
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  writeFileSync(`${home}/config.json`, JSON.stringify({
    port, hostname: "127.0.0.1", defaultProvider: "anthropic", clientIntegrations: { codex: false },
    providers: { anthropic: { adapter: "anthropic", baseUrl: FAKE, authMode: "oauth", allowPrivateNetwork: true, models: ["claude-stub", "claude-alt"] } },
    combos: { claude: { strategy: "failover", targets: [
      { provider: "anthropic", model: "claude-stub" }, { provider: "anthropic", model: "claude-alt" },
    ] } },
    ...config,
  }), { mode: 0o600 });
  const proc = Bun.spawn(["bun", CLI, "start", "--port", String(port)], {
    env: { ...process.env, OPENCODEX_HOME: home, HOME: home,
      OPENCODEX_ADMIN_AUTH_TOKEN: `ocx_admin_${crypto.randomUUID()}${crypto.randomUUID()}`, OPENCODEX_AGENTRADAR: "1" },
    stdout: "ignore", stderr: "pipe",
  });
  const ocx = { proc, home, base: `http://127.0.0.1:${port}`, log: "" };
  (async () => { for await (const chunk of proc.stderr) ocx.log += new TextDecoder().decode(chunk); })();
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${ocx.base}/healthz`)).status < 500) break; } catch { /* not up yet */ }
    if (i > 300) throw new Error(`OCX did not start: ${ocx.log}`);
    await Bun.sleep(100);
  }
  return ocx;
}
type Ocx = Awaited<ReturnType<typeof startOcx>>;

const ledgerText = (ocx: Ocx) => existsSync(join(ocx.home, "usage.jsonl")) ? readFileSync(join(ocx.home, "usage.jsonl"), "utf8") : "";
const ledger = (ocx: Ocx) => ledgerText(ocx).split("\n").filter(Boolean).map(line => JSON.parse(line));

/** One request; returns its HTTP status, the accounts it reached in order, and its ledger row. */
async function send(ocx: Ocx, path: string, body: object, headers: Record<string, string> = {}) {
  const rowsBefore = ledger(ocx).length;
  const from = sent.length;
  const res = await fetch(`${ocx.base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "unused", ...headers },
    body: JSON.stringify(body) });
  const text = await res.text();
  let rows = ledger(ocx);
  for (let i = 0; rows.length === rowsBefore && i < 100; i++) { await Bun.sleep(50); rows = ledger(ocx); }
  expect(rows.length).toBe(rowsBefore + 1);
  return { status: res.status, text, reached: sent.slice(from).map(accountOf), row: rows.at(-1) };
}
const msg = (ocx: Ocx, headers: Record<string, string> = {}) => send(ocx, "/v1/messages",
  { model: "claude-stub", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }, headers);
const combo = (ocx: Ocx) => send(ocx, "/v1/responses", { model: "combo/claude", input: "hi", stream: false });

/** Every attempt is labelled with the account it was sent to, and the row with the one that served. */
function expectServedBy(row: any, reached: Array<string | undefined>) {
  const served = reached.at(-1)!;
  expect(served).toBeDefined();
  expect(row.accountLogLabel).toBe(label(served));
  expect(row.attempts.map((a: any) => a.accountLogLabel)).toEqual(reached.map(id => label(id!)));
}

afterAll(() => {
  fake.stop(true);
  for (const home of homes) removeTreeWithRetry(home);
});

test("pool off: plain active, pinned and combo rows (with a failover inside the combo) name their serving account", async () => {
  limited.clear();
  const [alpha, bravo] = [ids[0]!, ids[1]!];
  const ocx = await startOcx(bravo, {});
  try {
    // Plain active account: the provider stays `anthropic` (unchanged), the label names the account.
    const plain = await msg(ocx);
    expect(plain.status).toBe(200);
    expect(plain.reached).toEqual([bravo]);
    expect(plain.row.provider).toBe("anthropic");
    expectServedBy(plain.row, plain.reached);

    // AgentRadar pin: the account-qualified provider keeps its form, and its suffix IS the label.
    const pinned = await msg(ocx, { "x-agentradar-account-provider": "claude", "x-agentradar-account-id": alpha });
    expect(pinned.status).toBe(200);
    expect(pinned.reached).toEqual([alpha]);
    expect(pinned.row.provider).toBe(`anthropic-${label(alpha)}`);
    expectServedBy(pinned.row, pinned.reached);

    // Combo, active account spent: the ladder fails over to another account, which serves.
    limited.add(`Bearer ${token(bravo)}`);
    const failover = await combo(ocx);
    expect(failover.status).toBe(200);
    expect(failover.reached[0]).toBe(bravo);
    expect(failover.reached.length).toBeGreaterThan(1);
    expect(failover.reached.at(-1)).not.toBe(bravo);
    expect(failover.row.provider).toBe("combo");
    expectServedBy(failover.row, failover.reached);

    // Masked only: no raw account id, token or email reaches the ledger.
    const text = ledgerText(ocx);
    for (const id of ids) {
      expect(text).not.toContain(id);
      expect(text).not.toContain(token(id));
    }
    expect(text).not.toContain("@example.invalid");
  } finally {
    ocx.proc.kill();
  }
}, 120_000);

test("pool on: pooled rows, an in-request pool failover and a pooled combo name their serving account", async () => {
  limited.clear();
  const ocx = await startOcx(ids[0]!, { anthropicAccountPool: { enabled: true, strategy: "round-robin" } });
  try {
    const pooled = await msg(ocx, { "thread-id": "ledger-s1" });
    expect(pooled.status).toBe(200);
    expect(pooled.reached).toHaveLength(1);
    expect(pooled.row.provider).toBe(`anthropic-${label(pooled.reached[0]!)}`);
    expectServedBy(pooled.row, pooled.reached);

    // Every account but one spent: one request walks the pool, and the last account serves.
    const survivor = ids[3]!;
    for (const id of ids.slice(0, 3)) limited.add(`Bearer ${token(id)}`);
    const walked = await msg(ocx, { "thread-id": "ledger-s2" });
    expect(walked.status).toBe(200);
    expect(walked.reached.at(-1)).toBe(survivor);
    expect(walked.row.provider).toBe(`anthropic-${label(survivor)}`);
    expectServedBy(walked.row, walked.reached);

    const pooledCombo = await combo(ocx);
    expect(pooledCombo.status).toBe(200);
    expect(pooledCombo.reached.at(-1)).toBe(survivor);
    expect(pooledCombo.row.provider).toBe("combo");
    expectServedBy(pooledCombo.row, pooledCombo.reached);
  } finally {
    ocx.proc.kill();
  }
}, 120_000);
