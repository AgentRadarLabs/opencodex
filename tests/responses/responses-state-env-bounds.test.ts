/**
 * Environment tightening of the continuation store's bounds.
 *
 * The built-in resident cap (64 MiB, counted as serialized bytes) and the 24 h
 * retention suit a long-lived host. A small instance needs both lower, without a
 * rebuild: OPENCODEX_RESPONSE_STATE_MAX_BYTES and OPENCODEX_RESPONSE_STATE_TTL_MS
 * may lower them, never raise them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  getSpilledResponseBytesForTests,
  getStoredResponseBytesForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseStateByteCapForTests,
  sweepExpiredResponseStates,
} from "../../src/responses/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CAP_ENV = "OPENCODEX_RESPONSE_STATE_MAX_BYTES";
const TTL_ENV = "OPENCODEX_RESPONSE_STATE_TTL_MS";
const SPILL_ENV = "OPENCODEX_RESPONSE_STATE_MAX_SPILL_BYTES";

function assistantItem(turn: number, chars = 1024) {
  return {
    id: `msg_env_${turn}`,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: `a${turn}:` + "y".repeat(chars) }],
  };
}

function rememberForced(id: string, input: unknown[], output: unknown[]): void {
  rememberResponseState(
    { model: "test/model", input, store: false },
    { id, status: "completed", output },
    undefined,
    { force: true },
  );
}

describe("responses-state environment bounds", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];
  const priorCap = process.env[CAP_ENV];
  const priorTtl = process.env[TTL_ENV];
  const priorSpill = process.env[SPILL_ENV];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-env-"));
    process.env["OPENCODEX_HOME"] = home;
    delete process.env[CAP_ENV];
    delete process.env[TTL_ENV];
    delete process.env[SPILL_ENV];
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
    if (priorCap === undefined) delete process.env[CAP_ENV];
    else process.env[CAP_ENV] = priorCap;
    if (priorTtl === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = priorTtl;
    if (priorSpill === undefined) delete process.env[SPILL_ENV];
    else process.env[SPILL_ENV] = priorSpill;
  });

  test("the resident byte cap can be lowered from the environment", () => {
    process.env[CAP_ENV] = String(256 * 1024);
    for (let index = 0; index < 8; index += 1) {
      rememberForced(
        `resp_solo_${index}`,
        [{ role: "user", content: `solo-${index}:` + "z".repeat(64 * 1024) }],
        [assistantItem(index)],
      );
    }
    expect(getStoredResponseBytesForTests()).toBeLessThanOrEqual(256 * 1024);
    expect(responseStateMetrics().spillStubCount).toBeGreaterThan(0);
  });

  test("retention can be shortened from the environment", () => {
    process.env[TTL_ENV] = String(60_000);
    rememberForced("resp_ttl", [{ role: "user", content: "hello" }], [assistantItem(0)]);
    expect(sweepExpiredResponseStates(Date.now() + 30_000)).toBe(0);
    expect(sweepExpiredResponseStates(Date.now() + 61_000)).toBe(1);
  });

  test("unlinked full-history turns stay under a lowered byte cap", () => {
    // A client that resends its whole history every turn, with no previous_response_id,
    // under forced storage: each turn is a fresh full copy under a fresh id, parsed anew.
    const cap = 512 * 1024;
    process.env[CAP_ENV] = String(cap);
    const history: unknown[] = [];
    let unboundedTotal = 0;
    for (let turn = 0; turn < 40; turn += 1) {
      history.push({ role: "user", content: `u${turn}:` + "x".repeat(4 * 1024) });
      const output = [assistantItem(turn, 4 * 1024)];
      const input = JSON.parse(JSON.stringify(history)) as unknown[];
      unboundedTotal += JSON.stringify(input).length + JSON.stringify(output).length;
      rememberForced(`resp_full_${turn}`, input, output);
      history.push(output[0]);
      expect(getStoredResponseBytesForTests()).toBeLessThanOrEqual(cap);
    }
    // The traffic itself is far past the cap, so the bound is doing the work.
    expect(unboundedTotal).toBeGreaterThan(4 * cap);
    const metrics = responseStateMetrics();
    expect(metrics.count).toBe(40);
    expect(metrics.residentCount).toBeGreaterThan(0);
    expect(metrics.spillStubCount).toBeGreaterThan(0);
  });

  test("the disk spill cap can be lowered from the environment, so a small temp disk is not filled", () => {
    // RAM cap low enough that every full-history turn spills; disk cap far below what the turns write.
    const spillCap = 128 * 1024;
    process.env[CAP_ENV] = String(32 * 1024);
    process.env[SPILL_ENV] = String(spillCap);
    const history: unknown[] = [];
    let written = 0;
    for (let turn = 0; turn < 30; turn += 1) {
      history.push({ role: "user", content: `u${turn}:` + "x".repeat(4 * 1024) });
      const output = [assistantItem(turn, 4 * 1024)];
      written += JSON.stringify(history).length + JSON.stringify(output).length;
      rememberForced(`resp_disk_${turn}`, JSON.parse(JSON.stringify(history)) as unknown[], output);
      history.push(output[0]);
    }
    expect(written).toBeGreaterThan(4 * spillCap);
    expect(getSpilledResponseBytesForTests()).toBeLessThanOrEqual(spillCap);
  });

  test("a fraction below 1 is ignored rather than flooring to 0 and emptying the store", () => {
    process.env[CAP_ENV] = "0.5";
    process.env[TTL_ENV] = "0.5";
    rememberForced("resp_fraction", [{ role: "user", content: "hello" }], [assistantItem(0)]);
    expect(responseStateMetrics().count).toBe(1);
    expect(getStoredResponseBytesForTests()).toBeGreaterThan(0);
    expect(sweepExpiredResponseStates(Date.now() + 1_000)).toBe(0);
  });

  test("a value above the built-in cap is ignored rather than raising it", () => {
    process.env[CAP_ENV] = String(Number.MAX_SAFE_INTEGER);
    process.env[TTL_ENV] = String(Number.MAX_SAFE_INTEGER);
    rememberForced("resp_raise", [{ role: "user", content: "hello" }], [assistantItem(0)]);
    // Still expires at the built-in 24 h retention.
    expect(sweepExpiredResponseStates(Date.now() + 24 * 60 * 60 * 1_000 + 1)).toBe(1);
  });
});
