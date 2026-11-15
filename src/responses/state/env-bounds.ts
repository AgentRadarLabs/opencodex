/**
 * Optional environment tightening of a built-in response-store bound: the resident byte cap
 * (OPENCODEX_RESPONSE_STATE_MAX_BYTES), retention (OPENCODEX_RESPONSE_STATE_TTL_MS) and the spill
 * cap (OPENCODEX_RESPONSE_STATE_MAX_SPILL_BYTES). Values above the default, or not a positive
 * number, are ignored: the defaults are part of the documented app-owned memory ceiling, and a
 * small instance needs a lower bound, never a higher one. Read per call, like the test
 * overrides, so a changed environment takes effect without a restart.
 */
export function envBoundAtMost(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(Math.floor(parsed), defaultValue);
}
