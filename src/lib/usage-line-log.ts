import { createHash } from "node:crypto";
import { baseProviderLabel } from "../providers/label";
import { sanitizeLogMetadataString } from "./redact";

/**
 * One structured log line per finished model call, so an operator can work out, per calling key,
 * the share of calls and tokens on each model from the process log alone.
 *
 * The line carries only the HTTP status, the provider and model ids, three token counts, an 8-hex
 * hash of the gateway API key's record id, the duration, the time to first token, an 8-hex hash of
 * the serving account's label and three 0/1 flags (a 429 was seen, a retry happened, the request
 * moved to another account or combo target). It never carries message text, a request or response
 * body, a header, a secret key value, an account label in clear or an email: the input is the
 * fork's own final request record, and only the fields named below are read from it.
 *
 * It is written only on an AgentRadar gateway (`OPENCODEX_AGENTRADAR=1`, the condition the
 * `[ar-acct]` line uses), so a self-hosted gateway gains no new output.
 */

/** Each id is cut to this many characters, newlines and control characters removed. */
export const USAGE_LOG_ID_MAX_CHARS = 80;

/** The fields of the final request record this line reads. Nothing else is looked at. */
export interface UsageLogInput {
  status: number;
  provider?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  /** The configured key's record id (never the secret key value). Absent for environment or loopback admission. */
  apiKeyId?: string;
  durationMs?: number;
  /** Ms from request start to the first non-empty output delta; absent for non-streaming or tool-only calls. */
  firstOutputMs?: number;
  /** The serving account's stable non-PII label; only its 8-hex hash is logged. */
  accountLogLabel?: string;
  /** True only when combo execution advanced to another configured target. */
  comboTargetAdvanced?: boolean;
  /** Upstream sends for the whole logical request; more than one means a retry. */
  spend?: { sends?: number };
  /** One row per physical attempt; only status, recovery counts and the account label are read. */
  attempts?: readonly {
    status?: number;
    recoveryKinds?: readonly unknown[];
    recoveryCount?: number;
    accountLogLabel?: string;
  }[];
}

/** The OAuth (`o`) and API-key (`k`) account labels `baseProviderLabel` leaves in place. */
const ACCOUNT_SUFFIX_RE = /-(?:o[a-f0-9]{6}|k[a-f0-9]{32})$/;

function idField(value: string | undefined): string {
  return JSON.stringify(sanitizeLogMetadataString(value, USAGE_LOG_ID_MAX_CHARS) ?? "-");
}

/**
 * A pooled provider is logged with the serving account's label as a suffix (`anthropic-p2e22d0`).
 * That label names one account, which this line must not, so the suffix is dropped.
 */
function providerField(value: string | undefined): string {
  const base = typeof value === "string" && value !== "" ? baseProviderLabel(value).replace(ACCOUNT_SUFFIX_RE, "") : value;
  return idField(base);
}

function count(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : "-";
}

/** First 8 hex of sha256 of a non-empty id, or "-" when there is none. */
function hash8(id: string | undefined): string {
  if (typeof id !== "string" || id === "") return "-";
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

/** First 8 hex of sha256 of the key record id, or "-" when the call carried no configured key. */
export function hashedKeyId(apiKeyId: string | undefined): string {
  return hash8(apiKeyId);
}

/** First 8 hex of sha256 of the serving account label (the entry's, else the last attempt's), or "-". */
export function hashedAccount(input: Pick<UsageLogInput, "accountLogLabel" | "attempts">): string {
  const last = [...(input.attempts ?? [])].reverse().find(a => typeof a.accountLogLabel === "string" && a.accountLogLabel !== "");
  return hash8(input.accountLogLabel || last?.accountLogLabel);
}

/** 429 / retry / fallover as 0 or 1, read from the attempt rows, spend total and combo flag only. */
export function usageLogFlags(input: UsageLogInput): { r429: 0 | 1; retry: 0 | 1; fallover: 0 | 1 } {
  const attempts = input.attempts ?? [];
  const labels = new Set(attempts.map(a => a.accountLogLabel).filter((l): l is string => typeof l === "string" && l !== ""));
  return {
    r429: input.status === 429 || attempts.some(a => a.status === 429) ? 1 : 0,
    retry: (input.spend?.sends ?? 0) > 1 || attempts.some(a => (a.recoveryCount ?? 0) > 0 || (a.recoveryKinds?.length ?? 0) > 0) ? 1 : 0,
    fallover: input.comboTargetAdvanced === true || labels.size > 1 ? 1 : 0,
  };
}

/** The line, without writing it. */
export function usageLogLine(input: UsageLogInput): string {
  const { usage } = input;
  const status = Number.isInteger(input.status) ? String(input.status) : "-";
  const { r429, retry, fallover } = usageLogFlags(input);
  return `[usage] status=${status} provider=${providerField(input.provider)} model=${idField(input.model)}`
    + ` in=${count(usage?.inputTokens)} out=${count(usage?.outputTokens)}`
    + ` cached=${count(usage?.cacheReadInputTokens ?? usage?.cachedInputTokens)}`
    + ` key=${hashedKeyId(input.apiKeyId)} ms=${count(input.durationMs)}`
    + ` ttft=${count(input.firstOutputMs)} acct=${hashedAccount(input)} r429=${r429} retry=${retry} fallover=${fallover}`;
}

/** Write the one line, on an AgentRadar gateway only. Never throws: logging must not fail a request. */
export function logUsageLine(input: UsageLogInput): void {
  if (process.env.OPENCODEX_AGENTRADAR !== "1") return;
  try {
    console.info(usageLogLine(input));
  } catch { /* request logging must never fail a user request */ }
}
