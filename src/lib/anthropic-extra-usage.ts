/**
 * Anthropic's quota refusal wordings: the HTTP 400s Anthropic sends for a spent account rather
 * than a bad request. Shared by the pool rotation and by `classifyError`, so both read the
 * refusal the same way.
 *
 * - Extra usage: an account whose plan AND extra usage are spent ("You're out of extra usage",
 *   "Third-party apps now draw from your extra usage").
 * - Spend limit: usage reached an organization or workspace spend limit the customer set. Per
 *   https://platform.claude.com/docs/en/api/rate-limits#setting-your-own-spend-limit this is
 *   HTTP 400 `invalid_request_error` whose message starts with "You have reached your specified
 *   API usage limits" or "You have reached your specified workspace API usage limits".
 *
 * Only the start of `error.message` counts: a validation 400 echoes client values (tool ids,
 * model names, prompt text) into its message, so a match anywhere else would let one crafted
 * request pass as a spent account and cool healthy accounts or a whole combo provider.
 */
const QUOTA_REFUSAL = new RegExp(
  "^(?:"
    + "you['\u2019]re out of extra usage"
    + "|third-party apps now draw from your extra usage"
    + "|you have reached your specified (?:workspace )?api usage limits"
    + ")",
  "i",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an already-extracted Anthropic `error.message` starts with a quota refusal wording. */
export function isAnthropicQuotaRefusalMessage(message: string): boolean {
  return QUOTA_REFUSAL.test(message.trimStart());
}

/**
 * Whether a parsed body is Anthropic's JSON error envelope (`type: "error"`,
 * `error.type: "invalid_request_error"`) whose `error.message` starts with a quota refusal wording.
 */
export function isAnthropicQuotaRefusalEnvelope(payload: unknown): boolean {
  if (!isRecord(payload) || payload.type !== "error" || !isRecord(payload.error)) return false;
  const { type, message } = payload.error;
  return type === "invalid_request_error"
    && typeof message === "string"
    && isAnthropicQuotaRefusalMessage(message);
}

/** {@link isAnthropicQuotaRefusalEnvelope} for a raw body; a non-JSON body is never the refusal. */
export function isAnthropicQuotaRefusalBody(body: string | null | undefined): boolean {
  if (!body) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  return isAnthropicQuotaRefusalEnvelope(payload);
}
