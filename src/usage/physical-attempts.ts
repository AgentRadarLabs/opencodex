/** Physical-attempt identity and its optional telemetry, shared by the ledger reader and every report. */

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One row per real upstream attempt: locally answered, unsent and duplicate-ordinal attempts are not. */
export function physicalUsageAttempts<
  T extends { ordinal?: number; sendCount?: number; locallyAnswered?: boolean },
>(attempts: readonly T[]): T[] {
  if (!Array.isArray(attempts)) return [];
  const seen = new Set<number>();
  return attempts.filter(attempt => {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return false;
    if (attempt.locallyAnswered === true || attempt.sendCount === 0) return false;
    if (!Number.isInteger(attempt.ordinal)) return true;
    if (seen.has(attempt.ordinal!)) return false;
    seen.add(attempt.ordinal!);
    return true;
  });
}

/**
 * The valid physical-send telemetry of a persisted attempt. Identity decides whether an attempt is
 * trustworthy; a malformed optional field costs only that field, since dropping the attempt would
 * delete a physical send from every report that sums them.
 */
export function physicalAttemptTelemetry(attempt: Record<string, unknown>): {
  firstSendAt?: number; promptCacheTtlMs?: number; recoveryCount?: number;
} {
  return {
    ...(isCount(attempt.firstSendAt) ? { firstSendAt: attempt.firstSendAt } : {}),
    ...(attempt.promptCacheTtlMs === 300_000 || attempt.promptCacheTtlMs === 3_600_000
      ? { promptCacheTtlMs: attempt.promptCacheTtlMs }
      : {}),
    ...(Number.isInteger(attempt.recoveryCount) && isCount(attempt.recoveryCount) ? { recoveryCount: attempt.recoveryCount } : {}),
  };
}

const MAX_SERVER_TOOL_USAGE_ENTRIES = 64;
const MAX_SERVER_TOOL_USAGE_KEY_LENGTH = 128;
const UNSAFE_SERVER_TOOL_USAGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Bounded Anthropic server-tool counters (`web_search_requests`, ...): plain object, finite counts. */
export function normalizeServerToolUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries: [string, number][] = [];
  for (const [key, count] of Object.entries(value)) {
    if (entries.length >= MAX_SERVER_TOOL_USAGE_ENTRIES) break;
    if (!key || key.length > MAX_SERVER_TOOL_USAGE_KEY_LENGTH || UNSAFE_SERVER_TOOL_USAGE_KEYS.has(key) || !isCount(count)) continue;
    entries.push([key, count]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
