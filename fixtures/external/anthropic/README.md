# Recorded Anthropic answers

Real samples of what Anthropic sends. A test that needs one of these loads it from here; it never hand-types a shorter or tidier copy.

- extra-usage-thirdparty-400.txt: REAL CAPTURE, byte-identical copy (git blob 2b121a6ba90f39457e82491079003a6899ca8811) of fixtures/external/anthropic-extra-usage-thirdparty-400.txt in AgentRadarLabs/agentradar-paperclip at commit 615ec8db6987fb7cab5cc3308ae3b6b3f95b8efe (manifest provenance "recorded"). It is a staging gateway log line for an Anthropic HTTP 400 on House inference, captured 2026-11-11: the prefix "Provider error 400: " then Anthropic's raw JSON error envelope, cut by the gateway logger at 200 characters (it ends mid-word at "and k"). It holds no account, org or request id, so nothing was redacted. Tests take the bytes after the prefix and add only the closing quote and braces the cut removed, so the envelope and message text stay as recorded.
- No real "You're out of extra usage" 400 body has been recorded. The paperclip sample of that wording is marked "derived" (not a live capture), so it is not copied here; the tests keep that wording as a typed string until a real one is logged.
