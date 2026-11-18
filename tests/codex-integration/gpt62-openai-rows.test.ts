/**
 * GPT-6.1 Terra, GPT-6.2 Astra and GPT-6.2 Sol native Codex rows: listed, ungated, routable as
 * natives, priced, and not the default.
 *
 * Held in its own file because tests/codex-integration/codex-catalog.test.ts sits at its
 * file-size ratchet cap (see AGENTS.md, "The file-size ratchet has almost no headroom").
 *
 * Evidence: the GPT-6.1 Terra row is pinned verbatim in src/codex/data/roster-pinned-models.json
 * from the upstream opencodex roster (500,000 / 872,000, low..ultra, default low). The two GPT-6.2
 * rows are DERIVED from the GPT-6.1 Sol row (272,000 / 872,000, low..ultra, default low) because no
 * upstream row exists yet. Prices come from the vendor's public models page; where it does not
 * publish a cached-input price the row carries input / 20.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCatalogEntries,
  NATIVE_OPENAI_MODELS,
  nativeDefaultReasoningEffort,
  nativeOpenAiCapabilitySourceSlug,
  nativeOpenAiContextTier,
  nativeReasoningEfforts,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  CONFIGURED_NATIVE_OPENAI_TEMPLATE_MODEL,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_GPT61_TERRA_MODEL,
  NATIVE_GPT62_ASTRA_MODEL,
  NATIVE_GPT62_SOL_MODEL,
  NATIVE_MAIN_DRAIN_SENTINEL_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
} from "../../src/codex/catalog/native-models";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS } from "../../src/codex/catalog/metadata";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { DEFAULT_SUBAGENT_MODELS } from "../../src/config/subagent-models";
import { getModelMetadata } from "../../src/generated/model-metadata";
import { EXPECTED_PRICE_OVERLAYS } from "../../src/usage/expected-prices";

afterEach(() => resetCodexModelEntitlementCacheForTests());

const LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

function efforts(entry: { supported_reasoning_levels?: unknown } | null | undefined): string[] {
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

const ROWS = [
  { slug: "gpt-6.1-terra", name: "GPT-6.1 Terra", defaultWindow: 500_000 },
  { slug: "gpt-6.2-astra", name: "GPT-6.2 Astra", defaultWindow: 272_000 },
  { slug: "gpt-6.2-sol", name: "GPT-6.2 Sol", defaultWindow: 272_000 },
] as const;

describe("GPT-6.1 Terra, GPT-6.2 Astra and GPT-6.2 Sol native Codex rows", () => {
  test("are self-described, ungated natives that resolve to themselves", () => {
    expect(NATIVE_GPT61_TERRA_MODEL).toBe("gpt-6.1-terra");
    expect(NATIVE_GPT62_ASTRA_MODEL).toBe("gpt-6.2-astra");
    expect(NATIVE_GPT62_SOL_MODEL).toBe("gpt-6.2-sol");
    for (const { slug } of ROWS) {
      expect(NATIVE_OPENAI_MODELS).toContain(slug);
      expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(slug)).toBe(true);
      expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)).toBe(false);
      expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(slug);
      expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(slug)).toBe(true);
      expect(nativeOpenAiCapabilitySourceSlug(slug)).toBe(slug);
    }
  });

  test("carry their own pinned rows: display name, context pair and effort ladder", () => {
    for (const { slug, name, defaultWindow } of ROWS) {
      expect(upstreamNativeEntry(slug)).toMatchObject({
        slug,
        display_name: name,
        visibility: "list",
        context_window: defaultWindow,
        max_context_window: 872_000,
      });
      expect(nativeOpenAiContextTier(slug)).toEqual({ defaultWindow, longWindow: 872_000 });
      expect(nativeReasoningEfforts(slug)).toEqual(LADDER);
      expect(nativeReasoningEfforts(slug)).toEqual(nativeReasoningEfforts(NATIVE_GPT6_SOL_MODEL));
      expect(nativeDefaultReasoningEffort(slug)).toBe("low");
    }
  });

  test("the built catalog lists each of them, with the full ladder, beside GPT-6 Sol", () => {
    const entries = buildCatalogEntries(null, [...ROWS.map(row => row.slug), NATIVE_GPT6_SOL_MODEL], []);
    for (const { slug } of ROWS) {
      const row = entries.find(entry => entry.slug === slug);
      expect(row?.visibility).toBe("list");
      expect(efforts(row)).toEqual(LADDER);
    }
    expect(entries.some(entry => entry.slug === NATIVE_GPT6_SOL_MODEL)).toBe(true);
  });

  test("do not change the defaults: GPT-6 Sol stays the subagent default and the configured-native template", () => {
    expect(DEFAULT_SUBAGENT_MODELS).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
    expect(CONFIGURED_NATIVE_OPENAI_TEMPLATE_MODEL).toBe(NATIVE_GPT6_SOL_MODEL);
  });
});

describe("GPT-6.1 Terra, GPT-6.2 Astra and GPT-6.2 Sol generated pricing", () => {
  const PRICES = {
    "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
    "gpt-6.2-astra": { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
    "gpt-6.2-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  } as const;

  test("ChatGPT-login and API rows carry the published input and output prices", () => {
    for (const [slug, cost] of Object.entries(PRICES)) {
      for (const provider of ["openai-codex", "openai"]) {
        expect(getModelMetadata(provider, slug)?.cost).toEqual(cost);
      }
    }
    expect(getModelMetadata("openai-codex", "gpt-6-sol")?.cost?.cacheRead).toBe(0.2);
  });

  test("the API-reference overlays match the generated rows", () => {
    for (const [slug, cost] of Object.entries(PRICES)) {
      for (const provider of ["openai-apikey", "openai"]) {
        const overlay = EXPECTED_PRICE_OVERLAYS.find(row => row.provider === provider && row.modelId === slug);
        expect(overlay?.cost4).toEqual(cost);
      }
    }
  });

  test("the GPT-6.2 API rows advertise the 1.05M window and 128K output", () => {
    for (const slug of ["gpt-6.2-astra", "gpt-6.2-sol"]) {
      for (const provider of ["openai-codex", "openai"]) {
        const meta = getModelMetadata(provider, slug);
        expect(meta?.contextWindow).toBe(1_050_000);
        expect(meta?.maxTokens).toBe(128_000);
      }
    }
  });
});
