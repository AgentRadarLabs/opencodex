/**
 * GPT-6.1 Sol native Codex row: listed, ungated, routable as a native, priced, and not the default.
 *
 * Held in its own file because tests/codex-integration/codex-catalog.test.ts sits at its
 * file-size ratchet cap (see AGENTS.md, "The file-size ratchet has almost no headroom").
 *
 * Evidence: openai/codex `codex-rs/models-manager/models.json` (row pinned verbatim in
 * src/codex/data/roster-pinned-models.json; low..ultra, default low, 272,000 / 872,000) and the
 * OpenAI pricing page ($2 in / $0.10 cached / $2.50 cache write / $10 out).
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
  NATIVE_GPT61_SOL_MODEL,
  NATIVE_MAIN_DRAIN_SENTINEL_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
} from "../../src/codex/catalog/native-models";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS } from "../../src/codex/catalog/metadata";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { DEFAULT_SUBAGENT_MODELS } from "../../src/config/subagent-models";
import { getModelMetadata } from "../../src/generated/model-metadata";

afterEach(() => resetCodexModelEntitlementCacheForTests());

const SOL_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

function efforts(entry: { supported_reasoning_levels?: unknown } | null | undefined): string[] {
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

describe("GPT-6.1 Sol native Codex row", () => {
  test("is a self-described, ungated native that resolves to itself", () => {
    expect(NATIVE_GPT61_SOL_MODEL).toBe("gpt-6.1-sol");
    expect(NATIVE_OPENAI_MODELS).toContain("gpt-6.1-sol");
    expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has("gpt-6.1-sol")).toBe(true);
    expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has("gpt-6.1-sol")).toBe(false);
    expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain("gpt-6.1-sol");
    expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has("gpt-6.1-sol")).toBe(true);
    expect(nativeOpenAiCapabilitySourceSlug("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  test("carries its own pinned row: display name, context pair and effort ladder", () => {
    expect(upstreamNativeEntry("gpt-6.1-sol")).toMatchObject({
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      visibility: "list",
      context_window: 272_000,
      max_context_window: 872_000,
    });
    expect(nativeOpenAiContextTier("gpt-6.1-sol")).toEqual({ defaultWindow: 272_000, longWindow: 872_000 });
    expect(nativeReasoningEfforts("gpt-6.1-sol")).toEqual(SOL_LADDER);
    expect(nativeReasoningEfforts("gpt-6.1-sol")).toEqual(nativeReasoningEfforts(NATIVE_GPT6_SOL_MODEL));
    expect(nativeDefaultReasoningEffort("gpt-6.1-sol")).toBe("low");
  });

  test("the built catalog lists it, with the full ladder, beside GPT-6 Sol", () => {
    const entries = buildCatalogEntries(null, ["gpt-6.1-sol", NATIVE_GPT6_SOL_MODEL], []);
    const row = entries.find(entry => entry.slug === "gpt-6.1-sol");
    expect(row?.visibility).toBe("list");
    expect(efforts(row)).toEqual(SOL_LADDER);
    expect(entries.some(entry => entry.slug === NATIVE_GPT6_SOL_MODEL)).toBe(true);
  });

  test("does not change the defaults: GPT-6 Sol stays the subagent default and the configured-native template", () => {
    expect(DEFAULT_SUBAGENT_MODELS).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
    expect(CONFIGURED_NATIVE_OPENAI_TEMPLATE_MODEL).toBe(NATIVE_GPT6_SOL_MODEL);
  });
});

describe("GPT-6.1 Sol generated pricing", () => {
  test("ChatGPT-login and API rows carry $2 in, $10 out, $0.10 cached", () => {
    for (const provider of ["openai-codex", "openai"]) {
      expect(getModelMetadata(provider, "gpt-6.1-sol")?.cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    }
    expect(getModelMetadata("openai-codex", "gpt-6-sol")?.cost?.cacheRead).toBe(0.2);
  });
});
