/** Private account proof from an authenticated Anthropic response, bound to its exact bearer. */
import { hasClaudeCredentialContinuity } from "./local-token-detect";
import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { CLAUDE_CLI_USER_AGENT } from "../providers/claude-cli-identity";
import type { OAuthCredentials } from "./types";
import { normalizeAnthropicPlan } from "../providers/anthropic-subscription";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_TIMEOUT_MS = 10_000;
const PROFILE_MAX_BYTES = 65_536;
export type AnthropicIdentity = NonNullable<OAuthCredentials["anthropicIdentity"]>;
export type AnthropicIdentityResolver = (access: string, signal?: AbortSignal) => Promise<(AnthropicIdentity & { plan?: string }) | undefined>;

export function bindAnthropicIdentity(access: string, accountUuid: unknown): AnthropicIdentity | undefined {
  if (!access || typeof accountUuid !== "string" || !accountUuid.length || accountUuid.length > 128
    || accountUuid !== accountUuid.trim() || /[\x00-\x1f\x7f]/.test(accountUuid)) return undefined;
  return { v: 1, accountUuid, bearerSha256: createHash("sha256").update(access).digest("hex") };
}

export function normalizeAnthropicIdentity(value: unknown, access: string): AnthropicIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proof = value as Partial<AnthropicIdentity>;
  const bound = bindAnthropicIdentity(access, proof.accountUuid);
  return proof.v === 1 && bound && proof.bearerSha256 === bound.bearerSha256 ? bound : undefined;
}

/** Fixed destination, no redirects, bounded body and deadline: the parsed profile or the refusal status. */
async function readAnthropicProfile(access: string, signal?: AbortSignal): Promise<{ data?: unknown; status?: number }> {
  if (!access || signal?.aborted) return {};
  const deadline = AbortSignal.timeout(PROFILE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(PROFILE_URL, {
      method: "GET", redirect: "error", signal: combined,
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "Cache-Control": "no-cache", "User-Agent": CLAUDE_CLI_USER_AGENT },
    });
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      return { status: response.status };
    }
    const body = await readBoundedResponseBody(response, {
      signal: combined, maxBytes: PROFILE_MAX_BYTES, fatalUtf8: true,
      totalTimeoutMs: PROFILE_TIMEOUT_MS, inactivityTimeoutMs: PROFILE_TIMEOUT_MS,
    });
    if (body.truncated || body.oversized || body.timedOut || combined.aborted) return {};
    return { data: JSON.parse(body.text) as unknown };
  } catch {
    return {};
  }
}

function profilePlan(data: unknown): string | undefined {
  const organization = data && typeof data === "object" && "organization" in data ? data.organization : undefined;
  const org = organization && typeof organization === "object" ? organization as Record<string, unknown> : undefined;
  return normalizeAnthropicPlan(org?.rate_limit_tier) ?? normalizeAnthropicPlan(org?.organization_type);
}

/** Failures never include response data. */
export const resolveAnthropicAccountIdentity: AnthropicIdentityResolver = async (access, signal) => {
  const { data } = await readAnthropicProfile(access, signal);
  // Unavailable identity is an explicit unresolved result, never an ownership guess.
  if (!data || typeof data !== "object" || !("account" in data)) return undefined;
  const account = data.account;
  const identity = account && typeof account === "object" && "uuid" in account
    ? bindAnthropicIdentity(access, account.uuid) : undefined;
  if (!identity) return undefined;
  const plan = profilePlan(data);
  return { ...identity, ...(plan ? { plan } : {}) };
};

export interface AnthropicPlanReading { plan: string | null; planUnknownReason?: string }
const planReadings = new Map<string, { until: number; value: Promise<AnthropicPlanReading> }>();

/**
 * A live plan read for an account whose credential has none stored yet (AgentRadar 20720). Keyed by
 * the bearer's digest, so a refresh reads afresh; an hour on success, five minutes on failure.
 */
export function readAnthropicPlan(access: string): Promise<AnthropicPlanReading> {
  const key = createHash("sha256").update(access).digest("hex");
  const now = Date.now();
  const hit = planReadings.get(key);
  if (hit && now < hit.until) return hit.value;
  // ponytail: cleared wholesale at 500 bearers; a pool never holds that many live logins.
  if (planReadings.size >= 500) planReadings.clear();
  const value = readAnthropicProfile(access).then(({ data, status }): AnthropicPlanReading => {
    if (status !== undefined) return { plan: null, planUnknownReason: `the plan lookup failed (HTTP ${status})` };
    if (data === undefined) return { plan: null, planUnknownReason: "the plan lookup did not answer" };
    const plan = profilePlan(data);
    return plan ? { plan } : { plan: null, planUnknownReason: "Anthropic did not report a plan" };
  });
  planReadings.set(key, { until: now + 5 * 60_000, value });
  void value.then(result => {
    if (result.plan && planReadings.get(key)?.value === value) planReadings.set(key, { until: now + 60 * 60_000, value });
  });
  return value;
}

/** A changed access bearer cannot inherit the previous bearer's proof. */
export function mergeAnthropicIdentity(fresh: OAuthCredentials, previous: OAuthCredentials): Pick<OAuthCredentials, "anthropicIdentity"> {
  const before = normalizeAnthropicIdentity(previous.anthropicIdentity, previous.access);
  const after = normalizeAnthropicIdentity(fresh.anthropicIdentity, fresh.access);
  if (before && after && before.accountUuid !== after.accountUuid) {
    throw new Error("Anthropic credential identity changed; explicit account login required");
  }
  return { anthropicIdentity: after ?? (fresh.access === previous.access ? before : undefined) };
}

/** Explicit imports enrich only a proven slot; labels and paths never establish ownership. */
export function matchesAnthropicImport(stored: OAuthCredentials, imported: OAuthCredentials): boolean {
  const before = normalizeAnthropicIdentity(stored.anthropicIdentity, stored.access);
  const after = normalizeAnthropicIdentity(imported.anthropicIdentity, imported.access);
  if (before && after) return before.accountUuid === after.accountUuid;
  return hasClaudeCredentialContinuity(stored, imported);
}
