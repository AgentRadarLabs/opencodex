import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { usageLogLine, type UsageLogInput } from "../../src/lib/usage-line-log";

const sha8 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

const PROMPT = "PROMPT-SECRET-please summarise the private contract for jane@example.com";
const KEY_ID = "key_rec_7f3a91c2d4";
const ACCT_A = "p2e22d0";
const ACCT_B = "p9a81c33";

function entry(overrides: Partial<UsageLogInput> = {}): UsageLogInput {
  return {
    status: 200,
    provider: "openai",
    model: "gpt-5.6-sol",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 40 },
    apiKeyId: KEY_ID,
    durationMs: 1234,
    firstOutputMs: 321,
    accountLogLabel: ACCT_A,
    ...overrides,
  };
}

describe("per-request summary line", () => {
  test("keeps the existing fields in order and appends the new ones", () => {
    const line = usageLogLine(entry());
    expect(line).toBe(
      `[usage] status=200 provider="openai" model="gpt-5.6-sol" in=100 out=10 cached=40`
      + ` key=${sha8(KEY_ID)} ms=1234 ttft=321 acct=${sha8(ACCT_A)} r429=0 retry=0 fallover=0`,
    );
  });

  test("a 429 then 200 row gives r429=1 retry=1", () => {
    const line = usageLogLine(entry({
      spend: { sends: 2 },
      attempts: [
        { status: 429, sendCount: 1, recoveryKinds: ["key-429"], recoveryCount: 1, accountLogLabel: ACCT_A },
        { status: 200, sendCount: 1, recoveryKinds: [], accountLogLabel: ACCT_A },
      ] as UsageLogInput["attempts"],
    }));
    expect(line).toContain(" r429=1 retry=1 fallover=0");
  });

  test("a recovery on a single send still counts as a retry", () => {
    const line = usageLogLine(entry({
      spend: { sends: 1 },
      attempts: [{ status: 200, recoveryKinds: ["oauth-401"], recoveryCount: 1, accountLogLabel: ACCT_A }],
    }));
    expect(line).toContain(" r429=0 retry=1 fallover=0");
  });

  test("two accounts across attempts give fallover=1", () => {
    const line = usageLogLine(entry({
      accountLogLabel: ACCT_B,
      attempts: [
        { status: 429, accountLogLabel: ACCT_A },
        { status: 200, accountLogLabel: ACCT_B },
      ],
    }));
    expect(line).toContain(" r429=1 ");
    expect(line).toContain(" fallover=1");
    expect(line).toContain(`acct=${sha8(ACCT_B)}`);
  });

  test("an advanced combo target gives fallover=1 on one account", () => {
    expect(usageLogLine(entry({ comboTargetAdvanced: true }))).toContain(" fallover=1");
  });

  test("a missing firstOutputMs gives ttft=- and a missing account gives acct=-", () => {
    const line = usageLogLine(entry({ firstOutputMs: undefined, accountLogLabel: undefined }));
    expect(line).toContain(" ttft=- acct=- ");
  });

  test("the line never carries the raw key id, the raw account label or prompt text", () => {
    const line = usageLogLine({
      ...entry({
        attempts: [
          { status: 429, accountLogLabel: ACCT_A },
          { status: 200, accountLogLabel: ACCT_B },
        ],
      }),
      // Fields the line must not read, even when a caller's wider record carries them.
      prompt: PROMPT,
      upstreamError: PROMPT,
      email: "jane@example.com",
    } as UsageLogInput);
    for (const secret of [KEY_ID, ACCT_A, ACCT_B, PROMPT, "PROMPT-SECRET", "jane@example.com"]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain(`key=${sha8(KEY_ID)}`);
    expect(line).toContain(`acct=${sha8(ACCT_B)}`);
  });
});
