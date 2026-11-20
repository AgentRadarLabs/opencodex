import { physicalUsageAttempts, usageTotalTokens, type PersistedUsageAttempt, type UsageStatus } from "../usage/log";
import { sumCreditReadings } from "../usage/credit-billing";
import type { OcxUsage } from "../types";

interface FinalizedUsageResult {
  usage?: OcxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

export function aggregateAttemptUsage(
  allAttempts: readonly PersistedUsageAttempt[],
): FinalizedUsageResult {
  // Only real upstream sends count: locally answered, unsent and duplicate-ordinal rows spent nothing.
  const attempts = physicalUsageAttempts(allAttempts);
  // A usage-less attempt that never reached upstream spent nothing (summary.ts `spentNothing`),
  // so it cannot leave the row's usage unknown.
  const dispatched = (attempt: PersistedUsageAttempt) => attempt.sendCount !== 0 && attempt.locallyAnswered !== true;
  const measured = attempts.filter(attempt => attempt.usage || dispatched(attempt));
  const status: UsageStatus = measured.length > 0
    && measured.every(attempt => attempt.usageStatus === "unsupported")
    ? "unsupported"
    : measured.some(attempt => (
        attempt.usageStatus === "unreported" || attempt.usageStatus === "unsupported"
      ))
      ? "unreported"
      : measured.some(attempt => attempt.usageStatus === "estimated")
        ? "estimated"
        : measured.length > 0
          ? "reported"
          : "unreported";

  const usages = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
  if (usages.length === 0) return { status };

  const sumOptional = (
    key: "cachedInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cacheCreation1hInputTokens"
      | "reasoningOutputTokens",
  ): number | undefined => {
    const present = usages.flatMap(usage => (
      typeof usage[key] === "number" ? [usage[key] as number] : []
    ));
    return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
  };
  // Readers take `cacheReadInputTokens ?? cachedInputTokens` (usage/cost.ts), so each attempt's read
  // counts once, under whichever field it reported, and both aggregate fields carry the same sum.
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens") === undefined && sumOptional("cachedInputTokens") === undefined
    ? undefined
    : usages.reduce((sum, usage) => sum + (usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0), 0);
  const cachedInputTokens = cacheReadInputTokens;
  // A context checkpoint is absolute (the latest wins); server-tool counters add.
  const contextTotalTokens = usages.findLast(usage => typeof usage.contextTotalTokens === "number"
    && Number.isFinite(usage.contextTotalTokens) && usage.contextTotalTokens >= 0)?.contextTotalTokens;
  const anthropicServerToolUse: Record<string, number> = {};
  for (const usage of usages) {
    for (const [name, value] of Object.entries(usage.anthropicServerToolUse ?? {})) {
      if (Number.isFinite(value) && value >= 0) anthropicServerToolUse[name] = (anthropicServerToolUse[name] ?? 0) + value;
    }
  }
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const cacheCreation1hInputTokens = sumOptional("cacheCreation1hInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const providerCredits = sumCreditReadings(attempts.filter(dispatched).map(attempt => attempt.usage?.providerCredits));
  const totalTokens = usages.reduce(
    (sum, usage) => sum + (usageTotalTokens(usage) ?? 0),
    0,
  );
  const aggregate: OcxUsage = {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation1hInputTokens !== undefined ? { cacheCreation1hInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(providerCredits !== undefined ? { providerCredits } : {}),
    ...(contextTotalTokens !== undefined ? { contextTotalTokens } : {}),
    ...(Object.keys(anthropicServerToolUse).length > 0 ? { anthropicServerToolUse } : {}),
    ...(status === "estimated" ? { estimated: true } : {}),
    ...(usages.every(usage => usage.upstreamReported) ? { upstreamReported: true as const } : {}),
  };
  return { usage: aggregate, status, totalTokens };
}

/** Responses (`input_tokens`) or Chat Completions (`prompt_tokens`) wire usage as an OcxUsage. */
export function usageFromResponsesPayload(usage: unknown): OcxUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown; cache_write_1h_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
    return {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.input_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.input_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.input_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.input_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_1h_tokens === "number"
        ? { cacheCreation1hInputTokens: raw.input_tokens_details.cache_write_1h_tokens }
        : {}),
      ...(typeof raw.output_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.output_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
    return {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.prompt_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.prompt_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.prompt_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.prompt_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.prompt_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.completion_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.completion_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  return undefined;
}
