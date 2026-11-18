// A local request-pacing refusal is this proxy's own queue answering, not provider quota: on an
// AgentRadar gateway it reaches the client as the local retryable 429, never cools the combo target,
// and sends nothing to the paced provider.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboProviderFactory } from "../helpers/combo-provider";
import { chatSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { resetProviderRequestPacingForTest, setProviderRequestPacingLimitsForTest, waitForProviderRequestSlot, releaseProviderRequestSlot } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";

const { handleResponses } = await import("../../src/server/responses");
const provider = comboProviderFactory(() => undefined);
const previous = { home: process.env.OPENCODEX_HOME, flag: process.env.OPENCODEX_AGENTRADAR };
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let home = "";
let release: (() => void) | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-pacing-"));
  process.env.OPENCODEX_HOME = home; process.env.OPENCODEX_AGENTRADAR = "1";
  clearComboSelectionState(); clearComboTargetCooldowns(); resetProviderRequestPacingForTest();
  release = acquireOwnedSpendHome();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  release?.(); release = undefined;
  resetProviderRequestPacingForTest(); clearComboSelectionState(); clearComboTargetCooldowns();
  if (previous.flag === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previous.flag;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  removeTreeWithRetry(home);
});

test("a local pacing 429 is answered locally and never cools the combo target", async () => {
  let aRequests = 0;
  const a = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { aRequests += 1; return chatSuccess("from a", "m1"); } });
  const b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => chatSuccess("from b", "m2") });
  servers.push(a, b);
  const url = (server: typeof a) => `${server.url.toString().replace(/\/$/, "")}/v1`;
  const config = { port: 0, defaultProvider: "a",
    providers: {
      a: provider("openai-chat", url(a), "key-a", { requestPacing: { enabled: true, maxConcurrentRequests: 1 } }),
      b: provider("openai-chat", url(b), "key-b"),
    },
    combos: { free: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
  } as OcxConfig;
  // A holds its only slot and has no queue, so its admission refuses locally with 429 queue_full.
  const held = await waitForProviderRequestSlot("a", config.providers.a!, "m1");
  setProviderRequestPacingLimitsForTest({ maxQueueDepth: 0 });
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(await response.text()).toContain("request pacing queue for provider 'a' is full");
    expect(aRequests).toBe(0);
    expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);
  } finally { releaseProviderRequestSlot(held); }
});
