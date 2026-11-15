import { sanitizeLogMetadataString } from "./redact";

/**
 * One structured log line per upstream 4xx, so an operator can learn which parameter or size limit
 * a provider refuses without reading anything a client sent.
 *
 * The line carries only the HTTP status, the provider and model ids, the `type` / `code` / `param`
 * of the provider's JSON error envelope, and the outgoing body size. It never carries the envelope's
 * `message`, a request or response body, a header, a credential or an account id: `message` is free
 * text that providers echo client content into, so no code path here ever reads it.
 */

/** Each envelope field is cut to this many characters, newlines and control characters removed. */
export const REFUSAL_FIELD_MAX_CHARS = 80;
/** An error envelope is small; read no more than this of a refusal body. */
const ENVELOPE_READ_LIMIT_BYTES = 64 * 1024;
/** A refusal body that never finishes is abandoned, not held. */
const ENVELOPE_READ_TIMEOUT_MS = 2_000;
/** Statuses the account and key rotation logs already report (`[key-failover]`, `[anthropic-pool]`). */
const ROTATION_LOGGED_STATUSES: ReadonlySet<number> = new Set([401, 429]);
/** An inbound body above this is logged at the gateway entry (a 6 MB request cap sits just above it). */
export const INBOUND_SIZE_LOG_THRESHOLD_BYTES = 5 * 1024 * 1024;

export interface RefusalEnvelopeFields {
  type?: string;
  code?: string;
  param?: string;
}

function envelopeScalar(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return sanitizeLogMetadataString(String(value), REFUSAL_FIELD_MAX_CHARS);
  return sanitizeLogMetadataString(value, REFUSAL_FIELD_MAX_CHARS);
}

/**
 * Read `type`, `code` and `param` from a provider's JSON error envelope (`error.*`, or the top level
 * of a flat envelope). Anything else, including `message`, is left unread. A body that is not
 * JSON yields no fields.
 */
export function refusalEnvelopeFields(text: string): RefusalEnvelopeFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  // Some providers wrap the envelope in a one-element array.
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  if (root === null || typeof root !== "object") return {};
  // `{"error": {...}}` is the common envelope. Some gateways answer flat, with the fields at the top
  // level and no `error` object; an `error` that is a bare string is that flat shape too.
  const nested = (root as { error?: unknown }).error;
  const source = nested !== null && typeof nested === "object" && !Array.isArray(nested) ? nested : root;
  const { type, code, param } = source as { type?: unknown; code?: unknown; param?: unknown };
  const fields: RefusalEnvelopeFields = {};
  const t = envelopeScalar(type);
  const c = envelopeScalar(code);
  const p = envelopeScalar(param);
  if (t !== undefined) fields.type = t;
  if (c !== undefined) fields.code = c;
  if (p !== undefined) fields.param = p;
  return fields;
}

/** Byte length of an outgoing request body, or undefined when it is a stream or form that cannot be measured without reading it. */
export function outgoingBodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  return undefined;
}

export interface UpstreamRefusal extends RefusalEnvelopeFields {
  status: number;
  provider?: string;
  model?: string;
  /** Outgoing request body size in bytes, when known. */
  bytes?: number;
}

function idField(value: string | undefined): string {
  // Ids are configuration-controlled and can be token-shaped: redacted, bounded and JSON-escaped.
  return JSON.stringify(sanitizeLogMetadataString(value, REFUSAL_FIELD_MAX_CHARS) ?? "-");
}

function envelopeField(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}=${JSON.stringify(value)}`;
}

/** Write the one line. `console.warn`, like the rotation logs this complements. */
export function logUpstreamRefusal(refusal: UpstreamRefusal): void {
  console.warn(
    `[upstream-refusal] status=${refusal.status} provider=${idField(refusal.provider)} model=${idField(refusal.model)}`
    + envelopeField("type", refusal.type) + envelopeField("code", refusal.code) + envelopeField("param", refusal.param)
    + ` bytes=${refusal.bytes ?? "-"}`,
  );
}

async function readEnvelopeText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, ENVELOPE_READ_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < ENVELOPE_READ_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Log the refusal shape of an upstream 4xx without disturbing it. The caller's response is returned
 * untouched; the envelope is read from a clone, off the request path, and a failure to read it
 * degrades to a line with the status, ids and size only.
 */
export function observeUpstreamRefusal(
  response: Response,
  context: { provider?: string; model?: string; body?: unknown },
): void {
  const { status } = response;
  if (status < 400 || status >= 500 || ROTATION_LOGGED_STATUSES.has(status)) return;
  const base: UpstreamRefusal = { status, provider: context.provider, model: context.model };
  const bytes = outgoingBodyBytes(context.body);
  if (bytes !== undefined) base.bytes = bytes;
  let copy: Response;
  try {
    copy = response.clone();
  } catch {
    logUpstreamRefusal(base);
    return;
  }
  readEnvelopeText(copy).then(
    text => logUpstreamRefusal({ ...base, ...refusalEnvelopeFields(text) }),
    () => logUpstreamRefusal(base),
  );
}

/**
 * The fork's own 413: a request or response that would not fit the translation buffer.
 * `limit` is the cap that was hit; `bytes` is the size when the caller knows it.
 */
export function logTranslationBufferLimit(
  where: "request" | "response" | "stream",
  context: { model?: string; bytes?: number; limit?: number },
): void {
  console.warn(
    `[upstream-refusal] status=413 provider="-" model=${idField(context.model)} code="translation_buffer_limit"`
    + ` where=${where} bytes=${context.bytes ?? "-"} limit=${context.limit ?? "-"}`,
  );
}

/** Log an inbound request above the threshold, from its declared Content-Length, before any body is read. */
export function logOversizedInbound(pathname: string, declaredBytes: number): void {
  if (!Number.isFinite(declaredBytes) || declaredBytes <= INBOUND_SIZE_LOG_THRESHOLD_BYTES) return;
  console.warn(`[inbound-size] path=${JSON.stringify(sanitizeLogMetadataString(pathname, REFUSAL_FIELD_MAX_CHARS) ?? "-")} bytes=${declaredBytes}`);
}
