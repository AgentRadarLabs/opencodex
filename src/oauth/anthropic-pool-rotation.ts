import { isAnthropicQuotaRefusalBody } from "../lib/anthropic-extra-usage";
import { readQuotaResetAt } from "../providers/key-failover";

/**
 * Why an upstream answer may move a request to the next Anthropic pool account.
 *
 * - `"429"`: a rate or quota limit, the original trigger.
 * - `"quota-400"`: Anthropic answers a spent account with HTTP 400, not 429: plan AND extra
 *   usage spent ("You're out of extra usage", "Third-party apps now draw from your extra usage"),
 *   or a spend limit the customer set ("You have reached your specified [workspace] API usage
 *   limits"). The account is spent; another pool account may not be.
 */
export type AnthropicPoolRotationTrigger = "429" | "quota-400";

/**
 * Whether a 400 body is Anthropic's quota refusal: Anthropic's JSON error envelope whose
 * `error.message` starts with one of its quota refusal wordings (src/lib/anthropic-extra-usage.ts).
 * Anything else, including a non-JSON body, is a request-shape failure that would fail the same
 * way on any account and must not rotate.
 */
export function isQuotaExhaustedBadRequest(status: number, body: string | null | undefined): boolean {
  return status === 400 && isAnthropicQuotaRefusalBody(body);
}

/** The pool-rotation trigger for an upstream status and (for a 400) its body, or null. */
export function isPoolRotatableStatus(
  status: number,
  body?: string | null,
): AnthropicPoolRotationTrigger | null {
  if (status === 429) return "429";
  return isQuotaExhaustedBadRequest(status, body) ? "quota-400" : null;
}

/**
 * Decide whether `response` should rotate the Anthropic pool. Only a 400 body is read: a bounded
 * prefix through the same peek the key-pool 429 path uses, and the returned response replays it,
 * so a caller that does not rotate still forwards the error unchanged. Any other status is
 * returned untouched. Throws only when `signal` aborts (client cancelled).
 */
export async function peekAnthropicPoolRotation(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; trigger: AnthropicPoolRotationTrigger | null }> {
  if (response.status !== 400) return { response, trigger: isPoolRotatableStatus(response.status) };
  const peeked = await readQuotaResetAt(response, { signal });
  return { response: peeked.response, trigger: isPoolRotatableStatus(400, peeked.text) };
}
