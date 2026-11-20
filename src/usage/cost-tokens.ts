import type { OcxUsage } from "../types";
import type { CostTokens } from "./cost";

// A leaf module so cache-provenance can share the pricing decomposition without an import cycle.
function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Normalize inclusive OcxUsage (types.ts: inputTokens INCLUDES cache read/write)
 * into jawcode CostTokens (input = uncached prompt only) without double-charging.
 *
 * Canonical-first with a single legacy retry: the canonical contract says
 * `cachedInputTokens` is read-only tokens, but legacy claude-route rows stored
 * read+write combined there (devlog 070). The two shapes are indistinguishable
 * by fields alone, so we apply the canonical reading first and only when it
 * produces an impossible R+W>I do we retry the legacy recovery
 * (cached - creation). If both readings are contradictory, fail closed (null).
 */
export function normalizeCostTokens(usage: OcxUsage): CostTokens | null {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const primaryRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const candidates: number[] = [primaryRead];
  if (typeof usage.cacheReadInputTokens !== "number"
    && typeof usage.cachedInputTokens === "number"
    && typeof usage.cacheCreationInputTokens === "number") {
    candidates.push(Math.max(0, usage.cachedInputTokens - usage.cacheCreationInputTokens));
  }
  for (const cacheRead of candidates) {
    if (![input, output, cacheRead, cacheWrite].every(finiteNonNegative)) return null;
    if (cacheRead + cacheWrite > input) continue;
    const cacheWrite1h = usage.cacheCreation1hInputTokens;
    return {
      input: Math.max(0, input - cacheRead - cacheWrite),
      output,
      cacheRead,
      cacheWrite,
      ...(typeof cacheWrite1h === "number" && finiteNonNegative(cacheWrite1h) && cacheWrite1h > 0
        ? { cacheWrite1h: Math.min(cacheWrite1h, cacheWrite) } : {}),
    };
  }
  return null;
}
