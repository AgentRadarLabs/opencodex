import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashedKeyId, logUsageLine, usageLogLine, USAGE_LOG_ID_MAX_CHARS } from "../../src/lib/usage-line-log";
import { addFinalRequestLog, clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { resetUsageReadCacheForTests } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Shaped as test sentinels so the privacy scan knows they are fake.
const PROMPT_TEXT = "DISTINCTIVE-PROMPT-TEXT-7731";
const API_KEY_SECRET = "sk-test-9942distinctive";
const AUTH_HEADER = "Bearer sk-test-header5531distinctive";
const KEY_ID = "key-record-1";

const LINE_RE = /^\[usage\] status=\d+ provider="[^"]*" model="[^"]*" in=(?:\d+|-) out=(?:\d+|-) cached=(?:\d+|-) key=(?:[0-9a-f]{8}|-) ms=(?:\d+|-)$/;

let infos: string[];
let restoreEnv: () => void;
let restoreSpy: () => void;

beforeEach(() => {
  infos = [];
  const spy = spyOn(console, "info").mockImplementation((...args: unknown[]) => { infos.push(args.map(String).join(" ")); });
  restoreSpy = () => spy.mockRestore();
  const previous = process.env.OPENCODEX_AGENTRADAR;
  process.env.OPENCODEX_AGENTRADAR = "1";
  restoreEnv = () => {
    if (previous === undefined) delete process.env.OPENCODEX_AGENTRADAR;
    else process.env.OPENCODEX_AGENTRADAR = previous;
  };
});
afterEach(() => { restoreSpy(); restoreEnv(); });

const usageLines = () => infos.filter(line => line.startsWith("[usage]"));

describe("usage line", () => {
  test("carries status, ids, counts, hashed key id and duration", () => {
    logUsageLine({
      status: 200, provider: "anthropic", model: "claude-test-1",
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900 },
      apiKeyId: KEY_ID, durationMs: 2150,
    });
    const expectedHash = createHash("sha256").update(KEY_ID).digest("hex").slice(0, 8);
    expect(usageLines()).toEqual([
      `[usage] status=200 provider="anthropic" model="claude-test-1" in=1200 out=340 cached=900 key=${expectedHash} ms=2150`,
    ]);
    expect(LINE_RE.test(usageLines()[0]!)).toBe(true);
  });

  test("cached falls back to cachedInputTokens and the key hash is stable per id", () => {
    expect(usageLogLine({ status: 200, usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 4 }, apiKeyId: KEY_ID })).toContain("cached=4");
    expect(hashedKeyId(KEY_ID)).toBe(hashedKeyId(KEY_ID));
    expect(hashedKeyId(KEY_ID)).not.toBe(hashedKeyId("key-record-2"));
  });

  test("missing counts, key and duration log as a dash", () => {
    logUsageLine({ status: 502 });
    expect(usageLines()).toEqual(['[usage] status=502 provider="-" model="-" in=- out=- cached=- key=- ms=-']);
    expect(hashedKeyId(undefined)).toBe("-");
    expect(hashedKeyId("")).toBe("-");
    const odd = usageLogLine({ status: 200, usage: { inputTokens: Number.NaN, outputTokens: -3 } });
    expect(odd).toContain("in=- out=- cached=-");
  });

  test("ids with newlines or 200 characters stay on one bounded line", () => {
    logUsageLine({
      status: 200, provider: "prov\r\nider\n[usage] status=200 forged", model: `m${"x".repeat(200)}\nsecond line`,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const [line] = usageLines();
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\r\n]/);
    expect(infos).toHaveLength(1);
    const model = /model="([^"]*)"/.exec(line!)![1]!;
    expect(model.length).toBeLessThanOrEqual(USAGE_LOG_ID_MAX_CHARS);
    expect(LINE_RE.test(line!)).toBe(true);
  });

  test("a pooled provider label drops the account suffix", () => {
    expect(usageLogLine({ status: 200, provider: "anthropic-p2e22d0" })).toContain('provider="anthropic"');
    expect(usageLogLine({ status: 200, provider: "xai-oabcdef" })).toContain('provider="xai"');
    expect(usageLogLine({ status: 200, provider: `acme-k${"a".repeat(32)}` })).toContain('provider="acme"');
    expect(usageLogLine({ status: 200, provider: "opencode-go" })).toContain('provider="opencode-go"');
  });

  test("is silent unless the AgentRadar mode is on", () => {
    delete process.env.OPENCODEX_AGENTRADAR;
    logUsageLine({ status: 200, provider: "anthropic", model: "claude-test-1" });
    process.env.OPENCODEX_AGENTRADAR = "0";
    logUsageLine({ status: 200, provider: "anthropic", model: "claude-test-1" });
    expect(infos).toEqual([]);
  });
});

describe("usage line from the final request record", () => {
  test("every finished call emits one line, and no text, secret or header reaches it", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-usage-line-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const ctx: RequestLogContext = {
        model: "claude-test-1",
        provider: "anthropic-p2e22d0",
        apiKeyId: KEY_ID,
        admissionKind: "configured",
        usage: { inputTokens: 800, outputTokens: 120, cacheReadInputTokens: 600 },
        // Fields that must never be read into the line.
        conversationId: PROMPT_TEXT,
        upstreamError: `${PROMPT_TEXT} ${API_KEY_SECRET} ${AUTH_HEADER}`,
        accountLogLabel: "p2e22d0",
        servedAccountId: "acct-distinctive-1@example.test",
      };
      addFinalRequestLog("ocx-usage-line-1", Date.now() - 50, ctx, 200, { closeReason: "non_stream" });
      const [line] = usageLines();
      expect(usageLines()).toHaveLength(1);
      expect(LINE_RE.test(line!)).toBe(true);
      expect(line).toContain('provider="anthropic" model="claude-test-1"');
      expect(line).toContain(`key=${hashedKeyId(KEY_ID)}`);
      for (const secret of [PROMPT_TEXT, API_KEY_SECRET, AUTH_HEADER, "Bearer", "acct-distinctive", "example.test", "p2e22d0", KEY_ID]) {
        expect(line).not.toContain(secret);
      }
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });

  test("a call with no usage and no configured key still logs one line with dashes", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-usage-line-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      addFinalRequestLog("ocx-usage-line-2", Date.now(), { model: "gpt-test", provider: "openai", admissionKind: "loopback" }, 499, { closeReason: "client_cancel" });
      expect(usageLines()).toHaveLength(1);
      expect(usageLines()[0]).toMatch(/^\[usage\] status=499 provider="openai" model="gpt-test" in=- out=- cached=- key=- ms=\d+$/);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });
});
