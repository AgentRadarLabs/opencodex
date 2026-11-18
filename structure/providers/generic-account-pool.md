# Generic OAuth Account Pool

Muse's in-band quota evidence follows the serving credential and its per-account incarnation independently of the operator's selection; selection still fences an in-flight publication. The physical-send and reset contracts are described in [Providers and adapters](../providers-and-adapters.md).

## Conversation affinity

`src/oauth/generic-session-affinity.ts` owns opt-in generic-pool conversation bindings. Provider-local
`oauthAccountFailover.sessionAffinity: "conversation"` requires proactive enablement; it does not
change reactive failover activation. Bindings are scoped to configuration home, provider and caller
principal, store only a hashed session key, account ID and selection receipt, and expire after 24 idle
hours within a process-wide 2,000-entry bound. Pause, reauth, model/family ineligibility and persisted
selection-revision changes release them. Cross-process revisions are checked on every lookup.
For `google-antigravity` a binding is kept per quota family (`gem`, `cla`) with the family-less key
as a read fallback, so a conversation alternating Gemini and Claude keeps one account per family. Each bind therefore writes two entries per session (the family key and the family-less key), and both count toward the 2,000-entry cap.
`src/oauth/session-affinity-key.ts` supplies the existing client-thread/header/cache-key precedence
for both generic and Anthropic callers; shared Desktop cache cohorts do not establish identity.

`src/server/responses/request-transport.ts` admits every automatic generic affinity-mode choice
without persisting an active-account change, including new/unkeyed sessions and failovers. The
operator's saved selection/revision fences queued sends independently of each conversation's serving
snapshot and credential generation. An unchanged selection with a renewed credential re-resolves
that same account; a changed selection follows the operator. Off-active 401 refresh remains bound
to the sent account. Admitted replacements rebind; affinity hits do not advance round-robin.
Fill-first has a bounded process-local cursor and prefers below-threshold alternatives without
moving the persisted selection. Kiro capacity retains wait/refusal semantics. Codex and Anthropic
are excluded. `tests/oauth/generic-session-affinity.test.ts` and
`tests/server/server-generic-oauth-affinity.test.ts` exercise these boundaries with synthetic accounts.

`src/types/provider.ts` declares the optional `sessionAffinity` mode; omission keeps existing behavior.

## Combo sibling probes

Antigravity sibling discovery passes its root/cache authority through `src/oauth/index.ts` to
generic refresh dispatch. After the account lock is acquired and newer credentials are adopted,
stale discovery stops before the token request without marking the account for reauthentication.
A rotation already dispatched still persists its result under the existing credential CAS.
An independent consumer sharing a discovery-cancelled flight releases its waiter permit before
one new resolution attempt. Callers carrying discovery authority keep the cancellation; unknown
stale outcomes, including post-dispatch uncertainty, never receive this automatic retry.

Antigravity model routing in `src/oauth/generic-account-failover.ts` ranks siblings by configured strategy or family headroom only within the best readiness/model-support tier. A known omission stays excluded, and unknown support stays usable. Reactive model-404 rotation excludes accounts already attempted in the request and prefers positive support before unknown support without changing account-wide auth or cooldown state.

Antigravity round-robin runs one ring per quota family: `genericPoolKey(provider, family)` in `src/oauth/pool-kernel.ts` keys the ring, and `preferredInitialAccount`, `noteGenericPoolSelection`, the model-listing reroute and reactive rotation all read the same model- and exhaustion-filtered candidate list, so the committed pick matches the peeked one and a Gemini request never advances the Claude ring. After the model-listing filter, `preferKiroModelSupport` drops accounts whose family quota is known to be spent unless every listing account is spent; unknown quota counts as headroom. A manual selection seeds the provider ring and both family rings through `seedGenericPoolSelection`, and `reconcilePoolRotationState` treats `generic:<provider>:<family>` keys as part of their provider. `tests/adapters/google/antigravity-account-roster.test.ts` covers the rings, the per-family affinity and the exhaustion filter.

`src/server/responses/core-combo.ts` asks `src/oauth/generic-account-failover.ts` whether a refused
account has an eligible sibling before cooling the whole target. This probe records the refused
account's cooldown but passes `commit: false`, so it only peeks at a round-robin pool. An unsent
sibling does not consume a sticky turn. Dispatching callers retain the default committed pick.
`tests/oauth/generic-oauth-combo-account-cooldown.test.ts` covers this distinction.

## AgentRadar hosted account contract

`src/lib/agentradar-account-pin.ts` is active only with `OPENCODEX_AGENTRADAR=1`. Its two pin headers
are accepted only on `/v1/messages`, `/v1/messages/count_tokens` and `/v1/chat/completions`; elsewhere, malformed, or with the flag
off they are refused before dispatch. A pin bypasses native managed lanes and caller credentials,
uses only its own provider's stored account, never commits the operator selection, and records refusal
evidence without selecting another account. The Codex pin uses the explicit-account selector and never
names the native main account. Helpers that cannot run on the pin refuse; Claude web search is bound
to the pinned primary-pool account. The served-account response header and hashed `[ar-acct]` line are
written only after a physical dispatch. Under round-robin, a keyed AgentRadar Anthropic session takes
the rendezvous-hash winner over eligible accounts before startup baseline or restored affinity; ordinary
installs keep the durable-affinity order above. A refused hashed session fails over to its hash runner-up, so every process agrees on it (`tests/adapters/anthropic/anthropic-agentradar-pool-parity.test.ts`). A streamed terminal-guard re-ask on such a gateway may also move off a refused (429/403) account, opening a new attempt, where ordinary installs never rotate after visible output (`tests/server/terminal-guard-agentradar-rotation.test.ts`). There a 429 with no unified status cools its account (Retry-After, else the default) and rotates, and an allowed unified status fails over at once without a same-account wait (`tests/adapters/anthropic/anthropic-agentradar-429.test.ts`). `stampAnthropicAccountForLog` also writes the serving account's `p<hex6>` into `accountLogLabel`, and `?quota=1` answers `plan` in the hosted vocabulary (`ultra`, `max`) while `planLabel` stays canonical. An organization-disabled refusal (`oauth_org_not_allowed`, or the structured `permission_error` with that exact wording) rotates as usual and also marks the account for reauthentication, since waiting out a cooldown cannot bring it back. On AgentRadar gateways a cached seven-day reading at 100% with a future reset is also a hard hold (selection, affinity, Retry-After and usage-limit answers), and a rejected seven-day refusal persists that reading, so a fresh process cannot seat a session on a spent account (`tests/adapters/anthropic/anthropic-weekly-spent-gate.test.ts`). It reads only cached evidence; no lazy usage probe runs on the request path. `tests/server/agentradar-account-pin-e2e.test.ts`
runs these cases against real gateway processes and a loopback supplier.

On these gateways `/v1/messages/count_tokens` for a canonical Anthropic target returns Anthropic's
exact count rather than the local estimate (`src/server/agentradar-count-tokens.ts`). The count sends the exact source to
`https://api.anthropic.com/v1/messages/count_tokens` under generation's combo eligibility, image policy,
cooldowns and key scope. A random combo picks from one request-correlation seed shared by the count and its turn.
A pinned count uses only its pinned account and refuses without a send when that account is unusable.
An unpinned count selects an account as a dispatch would and commits nothing. Counts are neither billed nor
request-logged. A noncanonical target, a declined native route and a pinned combo keep the estimate
(`tests/claude-integration/agentradar-count-tokens.test.ts`).
