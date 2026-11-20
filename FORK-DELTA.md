# AgentRadar refresh compatibility inventory

Compared hosted release `v2.65.0-vadymhimself.27` (`d0f166aca52d0cbe3dd132601ae8798aba8e002f`) with upstream `6bae884cbc66306cfbf4e0c2d50ba19fb79305a3` on 2026-11-18. All 99 raw fork-only commits were assigned to behavior groups. Because old port commits squash several concerns, parity was proven per behavior and per test case, not per commit.

## How parity was proven

1. **AR test oracle.** Every test case the AR line added (369) or changed (103) relative to its fork base was extracted from `.27` and run against pure upstream: 96 passed unchanged. Each of the other 376 cases was then resolved with evidence:
   - **Carried:** the `.27` test, with only import paths adapted and assertions unchanged, fails on upstream and passes on this branch.
   - **Equivalent:** an upstream test asserts the same behavior, or the `.27` test passes unchanged.
   - **Replaced-better:** upstream deliberately changed the behavior, with evidence that the replacement is safe and equal or better.
   - **Not carried:** the behavior is unreachable for AR traffic or would cause harm. The reason is recorded.
2. **Full upstream suite, both modes.** With `OPENCODEX_AGENTRADAR` unset, the failures are a subset of the pristine-upstream environment failures (same machine, same runner). With `OPENCODEX_AGENTRADAR=1`, the production mode, every failure that does not occur without the flag was triaged. Real hosted regressions were fixed with mutation-checked tests. The remaining flag-only failures are upstream tests that encode upstream-only behavior which hosted mode deliberately replaces with `.27` behavior; each group cites the `.27` behavior.
3. **AR gate.** `bun run test:gateway-quota` runs the AR contract tests in the existing CI `gates` job.

Working ledgers (per case, with commands and evidence) were kept outside the repository during the port; their dispositions are summarized below.

## Hosted contracts carried (gated by `OPENCODEX_AGENTRADAR=1` where upstream deliberately differs)

- **Per-request account pin** (`0c1162dae7` … `fbcc5b2285`): Messages, Chat and `count_tokens` only; refused when malformed or when hosted mode is off. Exact pinned account through every lane, including native Messages. No process-wide selection commit, no rotation off the pin, helpers refused or bound to the pin. The served-account header and the `[ar-acct]` line are written only after a physical send. Real loopback gateway e2e on fake and real-host base URLs; the real-host variant asserts that the native lane served the request.
- **Canonical Anthropic exact relay**: `https://api.anthropic.com/v1/messages` routes take the native lane. The caller's body is forwarded unchanged apart from the wire model and pooled-account metadata. No `ttl` injection, `context_management` is kept, caller betas pass. Upstream SSE and JSON bytes are relayed, with only Content-Type and a bounded Retry-After as headers. A strict SSE tap stops at the first terminal frame and records a root error as failed 502 and a stall as 504. Malformed frames fail before relay. Every rule is scoped to the canonical host; third-party Anthropic-compatible routes keep upstream handling.
- **Deterministic keyed placement** (`0428964be2`, `b60e434917`, `0c4ffad3e3`): rendezvous-hash seat ahead of restored affinity, with the hash runner-up on failover.
- **Pool policy**: a 16-account funded roster, always intersected with the request send budget. A header-less 429 cools the account for 60 seconds and rotates, but is reported to the client as a retryable rate limit, not usage-limit. Cached seven-day exhaustion is a hard hold, with no lazy probe. An org-disabled account rotates and is marked needs-reauth. Terminal re-asks rotate only on 429, quota-400 and org-disabled 403.
- **Quota and refusal handling for all installs**: account rotation on the exact extra-usage and spend-limit 400 envelopes (`45776369ce`). Field-only 400/422 quota evidence (`f4303eb19c`). Family-claim 429s. Pool 401 replay counted at the physical send. Credential-recovery attempt split (upstream #8882 / #8900).
- **Hosted combo policy**: verbatim final Anthropic errors, a 10-minute target cooldown cap (`d3ea59ccb9`) and a quorum-guarded stale-cooldown lift. Spend-limit and free-tier field hops. Combo aliases may carry typed tools to Anthropic targets. Restricted `web_search` keeps its translated fallback.
- **Observability**: the gated usage line (`8ca6f61ec5`) and the privacy-bounded refusal-shape log (`fae0ae4736`). Analytics `physicalBreakdown` and `redAlerts` plus the physical-attempt accounting used by summaries, health, the lab and route explainability. `p<hex6>` Anthropic account labels (`326bdfd7f7`), `comboTargetAdvanced`, cache TTL attribution, the `codex-account-retry` kind, and request-incompatible route traces.
- **Providers and state**: the `xai-apikey` identity (`de6381aa3b`), lower-only response-store environment bounds (`db4cf5cbef`), credit-journal expiry (`326e1a77b7`, co-authored by Gauge), Kimi `usages` precedence (`aa80674b33`), quota explanation (`af51f855b4`), the 20-minute Antigravity paste window (`d6d040ed32`), a 60-second API-key 429 cap, `.27` plan vocabulary for hosted `?quota=1`, and `--code` as an alias of `--headless`.
- **Claude ingress**: hosted exact `count_tokens` (pin-respecting; the `.27` bug that counted on an unpinned pool account is fixed). `prompt_cache_key` on session and parent session. The 5-minute cache default in hosted mode. Image 413 shrink on the native lane. Native-only client tools are refused before send.

## Replaced by upstream (do not reapply)

Native Messages replay (#7374), the server-tool/cache/usage bundle (#7225), per-account recovery usage (#7224), WebSocket/key-429/usage (#7389), redirect refusal (#8868), funded roster (#8871), cache boundary (#8212), native Codex refresh/revocation (#6515/#6523), combo admission ladder (#7355), Claude session-id extraction, and modern catalog rows (#8893; upstream prices kept). Old port-repair commits, version stamps and old manifests are not runtime value.

## Not carried, with reason

- Physical `count_tokens` for non-hosted installs: upstream estimates locally and spends nothing.
- The `.27` lazy weekly usage probe: replaced by the cached gate plus in-request rotation, which avoids the stale-observation race.
- The 4,096-frame inspector cap: it disabled accounting after one bursty read.
- The translated-path citation carrier: unreachable for AR after the canonical native lane.
- Fable temperature 0.3: Anthropic rejects it.
- Old fork release publisher: incompatible with upstream CI policy; see `FORK.md`.

## Known pre-existing failures

The suites listed in `FORK.md` fail identically on pristine upstream on the same machine: Rust ocx-child link (Xcode licence), service and route-to-home sandbox ownership, the catalog `models_cache.json` serve-options row, cli-connect-readiness, codex composed acceptance, update-stop-first, bun-install-frozen and test-git-isolation.
