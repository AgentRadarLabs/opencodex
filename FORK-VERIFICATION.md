# AR rebuild validation — 2026-11-19

## Inputs and boundaries

- Fixed upstream base: `6bae884cbc66306cfbf4e0c2d50ba19fb79305a3` (upstream package 2.100.0).
- Compatibility reference: `v2.65.0-vadymhimself.27`, `d0f166aca52d0cbe3dd132601ae8798aba8e002f`.
- Build version: `2.100.0-vadymhimself.1`.
- Runtime: pinned Bun 1.4.4. Tests use isolated HOME/OPENCODEX_HOME, synthetic credentials and loopback providers. Running laptop, Mini and hosted gateways were not replaced or deployed.
- Git history was not rebased or force-pushed; this is a fresh upstream-derived branch with the AR overlay reapplied.

## Evidence

| Check | Result | Meaning |
| --- | --- | --- |
| Pristine upstream full suite | 69,990 pass / 753 skip / 33 fail | Same-machine baseline, not a green full suite. |
| Rebuild full suite, hosted flag unset | 70,276 pass / 753 skip / 32 fail | Every failing test also fails on pristine upstream; no new failure names. |
| Rebuild full suite, hosted flag enabled | 69,985 pass / 753 skip / 323 fail | Hosted-only failures were grouped and reviewed against the intentional `.27` contract. These include upstream-only expectations for rewriting native bytes, 502 vs 504, six-account rosters, one-hour cache TTL, and sanitizing canonical server-tool history. Not a green full-suite result. |
| Final version-stamped AR gate | 522 pass / 0 fail across 29 files | Real-handler budget, cache-prefix, account pin, native fidelity, quota evidence, accounting and count-tokens regressions. |
| Typecheck, structure, privacy, diff check | Pass | Final version-stamped source. |
| Layout and file-size contracts | 38 pass / 0 fail | No baseline caps increased. |
| Dashboard/package build | Pass | Current upstream dependency versions and lockfiles retained. |
| Extracted package smoke | Pass | CLI reports the fork version, health endpoint returns 200, dashboard serves built HTML from an isolated home. |
| Live Claude cache parity | Blocked | User-authorized laptop probes hit Anthropic 429s. Waterfall used OpenAI; those cache hits do not establish Claude parity. |
| GitHub Actions | Unavailable | The fork rejects workflow dispatch with Actions disabled. No successful GitHub CI is claimed. |

The complete suites preceded the final small sidecar unused-reservation refund and version stamp. Those final changes were validated by the final AR gate, including Error and AbortError refund regressions, and all static/layout/file-size checks. The package smoke uses the final packed files.

## Compatibility method

The committed fork contained 99 fork-only commits, many of them mixed historical port squashes. A semantic inventory classified those changes. An additional oracle extracted 369 fork-added test cases and 103 modified test cases relative to the common base. Port owners recorded whether each behavior was carried, equivalent upstream, intentionally replaced, or unreachable. Literal `.27` tests that depend on removed internal modules were adapted to current seams, with fixture/assertion changes recorded in the working ledgers. The current contract and intentional replacements are summarized in `FORK-DELTA.md`.

Hosted-only full-suite failures were separately triaged across three disjoint slices. Confirmed defects found during that pass were fixed with focused regressions: canonical-only relay scope; response-header filtering; local error-frame identity preservation; combo-alias typed-tool eligibility; anchored quota evidence; classification before verbatim error presentation; retryable headerless 429s; restricted-search fallback; operator advisor opt-out; pinned count-tokens selection and unavailable-route fallback. Existing explicitly configured third-party native passthrough remains supported.

This is evidence for the exercised contracts, not a guarantee that every possible production configuration has been tested. The hosted deployment's actual secret-bearing configuration was not copied into the test tree. Read `FORK.md` before adapting the release pipeline or cutting over an existing gateway.

## Known environment failures

The paired baseline identifies local Rust/Xcode licence failures, sandbox/service ownership and route-intent fixtures, missing Codex catalog cache, connected-runtime probe expectations, composed Codex acceptance and update-stop-first. Some additional timing tests fail in broad runs and pass alone. These are disclosed, not retried into a blanket green claim.

## Delivery boundary

The build is a tarball candidate, not an npm publication, GitHub release tag, merge, deployment or installed runtime replacement. The old fork publisher requires a successful exact-SHA push-CI event that current upstream intentionally no longer creates. No gate was weakened to disguise that incompatibility.
