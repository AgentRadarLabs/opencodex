/**
 * AgentRadar hosted gateways (.27): `/v1/messages/count_tokens` for a canonical Anthropic target is
 * Anthropic's own exact count rather than the local estimate, because Claude Code decides when to
 * compact from this number. The count sends the exact source the native lane would send, under the
 * same eligibility, image policy, cooldowns and key scope as generation. A pinned request counts on
 * its pinned account only; an unpinned one selects an account exactly as a dispatch would and
 * commits nothing. It is neither billed nor request-logged. `undefined` keeps the local estimate.
 */
import { createHash } from "node:crypto";
import { buildAnthropicMessagesPassthroughRequest, isCanonicalAnthropicMessagesUrl } from "../adapters/anthropic/passthrough";
import { resolveInboundModel } from "../claude/inbound";
import { anthropicErrorResponse } from "../claude/outbound";
import { getCombo, pickComboTarget, resolveComboId } from "../combos";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { formatClientRetryAfter } from "../lib/client-retry-after";
import { agentRadarAccountPin, agentRadarPinnedConfig } from "../lib/agentradar-account-pin";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { applyUpstreamRecoveryInit } from "../lib/upstream-retry";
import { anthropicSessionKeyFromParts } from "../oauth/anthropic-routing";
import { publicOAuthAuthenticationErrorMessage } from "../oauth";
import { createProtocolEnvelope } from "../protocols/envelope";
import { featuresFromMessagesBody } from "../protocols/features";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import { captureRouteStaticPolicy, routeConcreteModel, routeModel, type RouteResult } from "../router";
import { POLICY_NAMESPACE, resolvePolicyProfileId } from "../routing/profile";
import type { OcxConfig } from "../types";
import { resolveWireProtocolOverride } from "./adapter-resolve";
import { resolveAdmissionModelScope, routeAllowedByScope } from "./admission-model-scope";
import type { DataPlaneAdmission } from "./auth-cors";
import { nativeMessagesDeclineReason, type NativeMessagesSelector } from "./messages-native-eligibility";
import { nativeOAuthBindingIsCurrent, resolveNativeOAuthBindingForInstance, type NativeOAuthBinding } from "./messages-native-oauth";
import { conversationIdFromClaudeMetadata } from "./request-log-conversation";
import { createComboProtocolLanes, hostedReplayIncompatible } from "./responses/core-combo-native";
import { providerFetch } from "./responses/fetch-helpers";

type Rec = Record<string, unknown>;
const COUNT_MAX_BYTES = 64 * 1024;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);
// The fields count_tokens and its Messages turn share; sampling, stream and metadata differ.
const SEED_FIELDS = ["cache_control", "context_management", "mcp_servers", "messages", "model", "output_config", "system", "thinking", "tool_choice", "tools"];
const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : isRec(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";

/** The .27 combo contract covers a combo only when one of its targets is canonical Anthropic. */
export function agentRadarCanonicalCombo(config: OcxConfig, cc: OcxConfig["claudeCode"], body: Rec): boolean {
  const combo = typeof body.model === "string" ? getCombo(config, resolveComboId(config, resolveInboundModel(body.model, cc)) ?? "") : undefined;
  return !!combo?.targets.some(target => {
    const provider = config.providers[target.provider];
    return provider?.adapter === "anthropic" && isCanonicalAnthropicMessagesUrl(provider);
  });
}

/**
 * One random-combo seed for a count_tokens request and the Messages turn it precedes (.27). Only a
 * combo with a canonical Anthropic target is correlated; other combos keep independent picks.
 */
export function agentRadarComboSeed(config: OcxConfig, cc: OcxConfig["claudeCode"], body: Rec): string | undefined {
  if (!agentRadarCanonicalCombo(config, cc, body)) return undefined;
  return createHash("sha256").update(canonicalJson(Object.fromEntries(SEED_FIELDS.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])))).digest("hex");
}

export async function agentRadarExactCountTokens(
  req: Request,
  config: OcxConfig,
  cc: OcxConfig["claudeCode"],
  raw: Rec,
  fastRow: boolean,
  admission?: DataPlaneAdmission,
): Promise<Response | undefined> {
  const pin = agentRadarAccountPin(req.headers);
  if (pin === null) return undefined; // refused by the caller before this runs
  if (typeof raw.model !== "string") return undefined;
  const selectorId = resolveInboundModel(raw.model, cc);
  if (resolvePolicyProfileId(config, selectorId) !== null || selectorId.startsWith(`${POLICY_NAMESPACE}/`)) return undefined;
  const scope = resolveAdmissionModelScope(config, admission);
  const selector: NativeMessagesSelector = { fastRow, claudeCode: cc, webSearchBackendAvailable: false };
  const translatorBudget = createTranslatorBudget();
  try {
    let route: RouteResult;
    try {
    const comboId = resolveComboId(config, selectorId);
    if (comboId) {
      // Generation refuses a pinned combo on the bridge; a pin never counts on a combo target.
      if (pin) return undefined;
      const combo = getCombo(config, comboId);
      if (!combo) return undefined;
      if (combo.imageInput === "disabled" && featuresFromMessagesBody(raw).has("request.images")) {
        return anthropicErrorResponse(400, `Combo "${comboId}" does not accept image input`, "invalid_request_error");
      }
      const lanes = createComboProtocolLanes({
        source: {
          inbound: "messages",
          envelope: createProtocolEnvelope({ inbound: "messages", body: raw, translatorBudget }),
          selector,
          dispatchNativeChild: () => Promise.reject(new Error("count_tokens never dispatches a combo child")),
        },
        req, config, logCtx: { model: selectorId, provider: comboId }, admissionScope: scope, comboId, targets: combo.targets,
      })!;
      // Preview: the generation that follows owns any round-robin or cooldown-reprobe state.
      const pick = pickComboTarget(config, comboId, {
        eligible: target => lanes.pickable(target), preview: true, allowCooldownReprobe: false, randomSeed: agentRadarComboSeed(config, cc, raw),
      });
      if (!pick) return lanes.refusal() ?? anthropicErrorResponse(503, `No available targets for combo: ${comboId}`, "api_error");
      route = routeConcreteModel(config, `${pick.target.provider}/${pick.target.model}`);
      selector.routeSelector = `${pick.target.provider}/${pick.target.model}`;
    } else {
      route = routeModel(config, selectorId);
      selector.routeSelector = selectorId;
      // A pin serves only its own Anthropic OAuth account, exactly as generation's pinServes.
      if (pin && !(pin.provider === "claude" && route.providerName === "anthropic" && route.provider.authMode === "oauth")) return undefined;
      if (raw.model !== route.modelId && hostedReplayIncompatible(raw, route.modelId)) {
        return anthropicErrorResponse(400, "request cannot be replayed exactly to canonical Anthropic", "invalid_request_error");
      }
    }
    } catch {
      // An unavailable or invalid route has no exact counter; keep upstream's local estimate.
      return undefined;
    }
    route.staticPolicy = captureRouteStaticPolicy(route.providerName, route.modelId, route.provider, route.staticPolicy.effectiveAlias, "anthropic");
    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "anthropic", route.staticPolicy);
    const countConfig = pin ? agentRadarPinnedConfig(config, pin) : config;
    if (route.provider.adapter !== "anthropic" || !isCanonicalAnthropicMessagesUrl(route.provider)
      || !routeAllowedByScope(scope, route)
      || nativeMessagesDeclineReason(route, raw, countConfig, selector) !== undefined) return undefined;

    let provider = route.provider;
    let providerAccountUuid: string | undefined;
    let binding: NativeOAuthBinding | undefined;
    if (provider.authMode === "oauth") {
      const instance = configuredAnthropicInstance(config, route.providerName);
      if (!instance) return undefined;
      try {
        binding = await resolveNativeOAuthBindingForInstance(instance, countConfig, {
          model: route.modelId,
          readOnly: true,
          sessionKey: anthropicSessionKeyFromParts({
            sessionIdHeader: req.headers.get("session_id")?.trim() || req.headers.get("x-claude-code-session-id"),
            threadIdHeader: req.headers.get("thread_id") ?? req.headers.get("thread-id"),
            clientThreadId: conversationIdFromClaudeMetadata(isRec(raw.metadata) ? raw.metadata : undefined) ?? null,
            promptCacheKey: null,
          }),
        });
        provider = { ...provider, apiKey: binding.snapshot.accessToken };
        providerAccountUuid = binding.providerAccountUuid;
      } catch (error) {
        // Fail closed for a pin: never estimate as if its own account had answered.
        if (pin) return anthropicErrorResponse(401, publicOAuthAuthenticationErrorMessage(error), "authentication_error");
        return undefined;
      }
    }

    let built: ReturnType<typeof buildAnthropicMessagesPassthroughRequest>;
    try {
      translatorBudget.chargeRetained(Buffer.byteLength(JSON.stringify(raw)), { kind: "request_copies" });
      built = buildAnthropicMessagesPassthroughRequest(provider, route.modelId, raw, config, {
        callerAnthropicBeta: req.headers.get("anthropic-beta"),
        providerAccountUuid,
        exactSource: true,
      });
      translatorBudget.chargeRetained(Buffer.byteLength(built.body), { kind: "request_copies" });
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) return undefined;
      return anthropicErrorResponse(413, "request translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
    }
    const countUrl = new URL(built.url);
    countUrl.pathname = "/v1/messages/count_tokens";
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(config.connectTimeoutMs ?? 200_000)]);
    try {
      const upstream = await providerFetch(provider, undefined, {
        providerName: route.providerName, modelId: route.modelId,
        dispatchOverride: async (input, init, execute, reacquirePacing) => {
          // Pacing may outlive a pause, removal or credential replacement. A count never commits a
          // selection; re-resolve the same pin (or the ordinary read-only pool) before the send.
          for (let attempt = 0; binding && !nativeOAuthBindingIsCurrent(binding); attempt++) {
            signal.throwIfAborted();
            if (attempt >= 3) throw new Error("Anthropic count credential changed before dispatch");
            binding = await resolveNativeOAuthBindingForInstance(binding.instance, countConfig, {
              routeTarget: binding.routeTarget, sessionKey: binding.sessionKey, model: route.modelId, readOnly: true,
            });
            provider = { ...route.provider, apiKey: binding.snapshot.accessToken };
            translatorBudget.releaseRetained(Buffer.byteLength(built.body), { kind: "request_copies" });
            built = buildAnthropicMessagesPassthroughRequest(provider, route.modelId, raw, config, {
              callerAnthropicBeta: req.headers.get("anthropic-beta"), providerAccountUuid: binding.providerAccountUuid, exactSource: true,
            });
            translatorBudget.chargeRetained(Buffer.byteLength(built.body), { kind: "request_copies" });
            await reacquirePacing?.(provider, route.modelId);
          }
          signal.throwIfAborted();
          return execute(input, applyUpstreamRecoveryInit({ ...init, headers: built.headers, body: built.body }, "connection-reset"));
        },
      })(
        countUrl,
        applyUpstreamRecoveryInit({ method: "POST", headers: built.headers, body: built.body, signal }, "connection-reset"),
      );
      const read = await readBoundedResponseBytes(upstream, { signal, maxBytes: COUNT_MAX_BYTES });
      if (read.oversized) return anthropicErrorResponse(502, "Anthropic token count body exceeded safe limit", "api_error");
      const retryAfter = formatClientRetryAfter(upstream.headers.get("retry-after"));
      return new Response(read.bytes.slice(), {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
      });
    } catch {
      if (req.signal.aborted) return anthropicErrorResponse(499, "client closed request during Anthropic token count", "api_error");
      if (signal.aborted) return anthropicErrorResponse(504, "Anthropic token count timed out", "timeout_error");
      return anthropicErrorResponse(502, "Anthropic token count failed", "api_error");
    }
  } finally {
    translatorBudget.dispose();
  }
}
