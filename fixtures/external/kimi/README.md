# Documented Kimi answers

Samples of what Kimi's `GET /coding/v1/usages` sends, taken from Kimi's own published client code, not captured from live traffic. A test that needs one of these loads it from here; it never hand-types a shorter or tidier copy.

- client-test-usages-full.json: the usages payload in the test "parses the full payload" of Kimi's own client, MoonshotAI/kimi-code, `packages/oauth/test/managed-usage.test.ts` (https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/test/managed-usage.test.ts), read 2026-11-15. The fields are copied as written there and serialized as JSON, the way that test's own fetch mock serializes its body; the vendor's parser reading it is `packages/oauth/src/managed-usage.ts`. It is the vendor's documented shape, not a live capture: no live `/usages` body has been recorded. It holds no key, account or request id.
