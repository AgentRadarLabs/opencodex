# AgentRadar gateway overlay

This branch starts from upstream `lidge-jun/opencodex` development history, not from the old fork's accumulated port commits. The refresh baseline is `6bae884cbc66306cfbf4e0c2d50ba19fb79305a3` (2026-11-18). The source gateway release for the compatibility inventory is `v2.65.0-vadymhimself.27` (`d0f166aca52d0cbe3dd132601ae8798aba8e002f`).

What was carried, replaced or dropped is in [FORK-DELTA.md](./FORK-DELTA.md). Exact validation results and their limits are in [FORK-VERIFICATION.md](./FORK-VERIFICATION.md).

Hosted gateways run with `OPENCODEX_AGENTRADAR=1`. Every AR behavior that deliberately differs from upstream is behind that flag. Without it, this branch behaves like upstream except for generic defect fixes that apply to all installs.

## Maintenance contract

- Keep upstream implementation, dependency versions, generated catalogs and release machinery unless an explicitly documented hosted requirement needs an overlay. A different commit hash does not establish a missing fix: upstream often lands fixes through squash merges or maintainer carries.
- Keep hosted account binding, serving-account visibility and deterministic session placement in a small, tested overlay. Do not replace upstream routing or retry implementations wholesale to preserve these entry points.
- Preserve upstream request-wide physical-send accounting, cancellation, refusal evidence, credential ownership and committed-output boundaries. The hosted 16-account roster is always intersected with the request send budget.
- To branch new gateway work, start from this line. PRs against the old `release/2.65.0-vadymhimself.*` branches are stale and must be re-cut here.
- Keep every genuinely missing generic fix in a separately attributable change so it can be removed when the upstream implementation lands. Record the upstream PR and the original fork commit.
- Refresh from a fixed upstream SHA in a new isolated worktree. Compare the overlay against current upstream behavior, drop equivalents and apply only the remaining changes. Do not rewrite a published release branch, rebase open upstream PRs, force-push, or carry the old baseline's generated files and dependency manifests over newer upstream versions.
- Do not copy local credentials, account databases, logs or deployment configuration into a refresh worktree. Synthetic credentials and loopback mock providers are sufficient for compatibility tests.

## Gateway checks

Run `bun run test:gateway-quota` in addition to the affected suites and the standard typecheck, structure and privacy checks. The command is included in the existing CI `gates` job without changing its triggers, permissions or runner selection.

The gateway gate exercises the AR account pin through real loopback gateway processes, exact canonical Anthropic relay, hosted pool and combo policy, physical-send bounds, funded-roster limits, sidecar reservation ownership, quota-echo resistance, `count_tokens`, analytics and usage logs. Each hosted test sets the flag itself, so the gate runs in the existing CI job without it. An offline pass proves the asserted wire/accounting contracts, not a live Anthropic cache-hit rate or production cost reduction. Missing GitHub checks are not a pass.

For the next refresh, also run the full suite with `OPENCODEX_AGENTRADAR=1` and triage every failure that does not occur without the flag. Upstream tests encode upstream behavior, so a hosted failure is acceptable only when it matches a documented `.27` behavior. Pre-existing environment failures on this machine: Rust ocx-child link (Xcode licence), service and route-to-home sandbox ownership, the catalog `models_cache.json` serve-options row, cli-connect-readiness, codex composed acceptance, update-stop-first, bun-install-frozen and test-git-isolation.

## Release boundary

Preparing this branch does not replace the running gateway or authorize publication. Keep the current laptop build and hosted release line intact until the candidate is validated and deployment is explicitly approved.

The old fork publishes through `.github/workflows/fork-release.yml` after successful exact-SHA push CI on its release line. Current upstream deliberately has no push CI trigger and uses a different release-evidence contract. These workflows are not interchangeable. The refresh does not copy the old publisher, enable Actions, weaken its successful-CI requirement, add release triggers or publish a tag. Release integration requires a separate reviewed change before any cutover.

The initial publication of a new `release/2.100.0-vadymhimself` branch was rejected by the existing required `ci` rule while Actions was disabled. The pristine reference is `baseline/ar-upstream-2026-11-18`; the candidate overlay is `port/ar-on-upstream-2026-11-18`. The rebuild PR targets that reference for a bounded diff. No release-branch protection was bypassed or changed.
