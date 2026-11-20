import type { OcxConfig } from "../types";

const ACCOUNT_PIN = Symbol.for("agentradar.accountPin");
export interface AgentRadarAccountPin { provider: "claude" | "codex" | "grok" | "kimi"; accountId: string }
type PinnedConfig = OcxConfig & { [ACCOUNT_PIN]?: AgentRadarAccountPin };
const servedAccounts = new WeakMap<object, string>();

/** Only the authenticated AgentRadar embedding bridge may supply these headers. */
export function agentRadarAccountPin(headers: Headers): AgentRadarAccountPin | null | undefined {
  const accountId = headers.get("x-agentradar-account-id");
  const provider = headers.get("x-agentradar-account-provider");
  if (accountId === null && provider === null) return undefined;
  if (process.env.OPENCODEX_AGENTRADAR !== "1" || !accountId || !/^[!-~]{1,256}$/.test(accountId)) return null;
  return provider === "claude" || provider === "codex" || provider === "grok" || provider === "kimi" ? { provider, accountId } : null;
}

export function agentRadarPin(config: OcxConfig): AgentRadarAccountPin | undefined {
  return (config as PinnedConfig)[ACCOUNT_PIN];
}

export function agentRadarPinnedConfig<T extends OcxConfig>(config: T, pin: AgentRadarAccountPin): T {
  return { ...config, [ACCOUNT_PIN]: pin,
    ...(pin.provider === "claude" ? { webSearchSidecar: { ...config.webSearchSidecar, backend: "anthropic" as const, anthropicInstance: "anthropic" as const } } : {}) };
}

/** Request-local attribution only, never serialized into ordinary request logs. */
export function noteAgentRadarAccountDispatch(context: object, accountId: string, reason?: string, sessionKey?: string | null): void {
  if (process.env.OPENCODEX_AGENTRADAR !== "1") return;
  servedAccounts.set(context, accountId);
  if (reason) {
    const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);
    console.error(`[ar-acct] a=${digest(accountId)} r=${reason} s=${sessionKey ? digest(sessionKey) : "none"}`);
  }
}

export function withAgentRadarServedAccount(response: Response, context: object): Response {
  const accountId = servedAccounts.get(context);
  if (!accountId || process.env.OPENCODEX_AGENTRADAR !== "1") return response;
  response.headers.set("x-agentradar-served-account-id", accountId);
  return response;
}
