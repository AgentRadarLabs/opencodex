# Recorded OpenCode Go answers

Real samples of what the provider sends. A test that needs one of these loads it from here; it never hand-types a shorter or tidier copy.

- reasoning-effort-max-400.json: the 400 body OpenCode Zen Go returned for `reasoning_effort: max` on muse-spark-1.3-contributor, recorded by the maintainers on 2026-09-12 in this repository's devlog (devlog/_plan/260912_reasoning_metadata/000_decision.md, section "Why the hand-written table was not enough"). The devlog wraps the body across lines; the three wrapped lines are joined with single spaces and nothing else is changed. It holds no key, account or request id.
- It has `param` and `type` but no `error.code`. No recorded body with an `error.code` and an `error.param` together has been found; the tests do not type one.
