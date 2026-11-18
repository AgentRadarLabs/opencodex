// .27 parity (tests/images/loop.test.ts "runTurn adapter paces and records every physical dispatch"),
// at the server seam: a forward-auth runTurn provider is not wrapped by request-transport's
// runSelectedTurn, so the image bridge's runTurnFetch is what paces its sends inside the turn lease.
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let release: (() => void) | undefined;
let restore: (() => void) | undefined;
let handleResponses: typeof import("../../src/server/responses")["handleResponses"];
let upstream: ReturnType<typeof Bun.serve>;
let sends = 0;
let inFlightDuringTurn: number[] = [];
let config: OcxConfig;

function runTurnAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "openai-chat",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "{}" }),
    async *parseStream() { yield { type: "done" as const }; },
    async runTurn(_parsed, incoming, emit) {
      if (!incoming.providerFetch) throw new Error("missing provider fetch");
      for (let i = 0; i < 3; i++) {
        await (await incoming.providerFetch(`${provider.baseUrl}/send-${i}`, { method: "POST", body: "{}" })).text();
        inFlightDuringTurn.push(providerRequestPacingStatus("rtpaced", config.providers.rtpaced!).inFlight);
      }
      emit({ type: "text_delta", text: "sent" });
      emit({ type: "done" });
    },
  } as ProviderAdapter;
}

beforeAll(async () => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { sends += 1; return new Response("{}"); } });
  const actual = { ...await import("../../src/server/adapter-resolve") };
  restore = () => mock.module("../../src/server/adapter-resolve", () => actual);
  mock.module("../../src/server/adapter-resolve", () => ({
    ...actual,
    resolveAdapter: (provider: OcxProviderConfig, retention?: "none" | "short" | "long", name?: string) =>
      provider.adapter === "test-runturn-image" ? runTurnAdapter(provider) : actual.resolveAdapter(provider, retention, name),
  }));
  ({ handleResponses } = await import("../../src/server/responses"));
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-image-runturn-")); process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome(); resetProviderRequestPacingForTest(); sends = 0; inFlightDuringTurn = [];
  config = {
    port: 0, defaultProvider: "rtpaced", images: { bridgeEnabled: true },
    providers: {
      rtpaced: { adapter: "test-runturn-image" as OcxProviderConfig["adapter"], baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        authMode: "forward", allowPrivateNetwork: true, models: ["m"], requestPacing: { enabled: true, maxConcurrentRequests: 1 } },
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "synthetic-xai-key", models: ["grok-imagine-image"] },
    },
  } as OcxConfig;
});
afterEach(() => {
  release?.(); release = undefined; resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
afterAll(async () => { mock.restore(); restore?.(); await upstream.stop(true); });

test("a forward-auth runTurn provider paces every image-bridge send inside its turn lease", async () => {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-caller" },
    body: JSON.stringify({ model: "rtpaced/m", input: "draw", stream: true, tools: [{ type: "image_generation" }] }),
  }), config, { model: "", provider: "" });
  expect(await response.text()).toContain("sent");
  expect(sends).toBe(3);
  expect(inFlightDuringTurn).toEqual([1, 1, 1]);
  expect(providerRequestPacingStatus("rtpaced", config.providers.rtpaced!).inFlight).toBe(0);
});
