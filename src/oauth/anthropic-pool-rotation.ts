import { readQuotaResetAt } from "../providers/key-failover";

/**
 * Why an upstream answer may move a request to the next Anthropic pool account.
 *
 * - `"429"`: a rate or quota limit, the original trigger.
 * - `"quota-400"`: Anthropic answers an account whose plan AND extra usage are spent with
 *   HTTP 400 ("You're out of extra usage", "Third-party apps now draw from your extra usage"),
 *   not 429. The account is spent; another pool account may not be.
 */
export type AnthropicPoolRotationTrigger = "429" | "quota-400";

/**
 * Anthropic's spent-extra-usage wordings, anchored at the start of `error.message`. Only the
 * start counts: a validation 400 echoes client values (tool ids, model names, text) into its
 * message, so a match anywhere else would let one crafted request cool every pool account.
 */
const EXTRA_USAGE_REFUSAL = /^(?:you['\u2019]re out of extra usage|third-party apps now draw from your extra usage)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a 400 body is Anthropic's out-of-extra-usage refusal. It must be Anthropic's JSON error
 * envelope (`type: "error"`, `error.type: "invalid_request_error"`) whose `error.message` starts
 * with one of the two wordings. Anything else, including a non-JSON body, is a request-shape
 * failure that would fail the same way on any account and must not rotate.
 */
export function isQuotaExhaustedBadRequest(status: number, body: string | null | undefined): boolean {
  if (status !== 400 || !body) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isRecord(payload) || payload.type !== "error" || !isRecord(payload.error)) return false;
  const { type, message } = payload.error;
  return type === "invalid_request_error"
    && typeof message === "string"
    && EXTRA_USAGE_REFUSAL.test(message.trimStart());
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
