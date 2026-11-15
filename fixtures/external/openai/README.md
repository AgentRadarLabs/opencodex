# Documented OpenAI answers

Samples taken from OpenAI's public documentation, not captured from live traffic. A test that needs one of these loads it from here; it never hand-types a shorter or tidier copy.

- docs-invalid-service-tier-400.json: the 400 described in OpenAI's error codes guide (https://developers.openai.com/api/docs/guides/error-codes), section "400 - Invalid service_tier argument". The guide gives the message text, the `invalid_request_error` type and `error.param` set to `service_tier` in prose, not as a JSON body; they are placed in OpenAI's standard `{"error": {message, type, param, code}}` envelope. The guide names no code for this error, so `code` is null. It holds no key, account or request id.
