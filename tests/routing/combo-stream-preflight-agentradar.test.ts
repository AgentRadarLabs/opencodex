import { describe, expect, test } from "bun:test";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";

// Split from combo-stream-preflight.test.ts to keep it under the file-size ratchet.
const sse = (...payloads: unknown[]): Response => new Response(
  payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

describe("combo stream preflight (AgentRadar hosted)", () => {
  test("AgentRadar hosted: converts zero-output transport incompletes into retryable HTTP failures", async () => {
    const previous = process.env.OPENCODEX_AGENTRADAR;
    process.env.OPENCODEX_AGENTRADAR = "1";
    try {
      const cases = [
        ["adapter_eof", "Upstream stream ended unexpectedly without a terminal event", 502],
        ["missing_terminal_event", "Upstream incomplete", 502],
        ["upstream_stall_timeout", "Upstream stalled", 504],
      ] as const;
      for (const [reason, message, status] of cases) {
        const result = await preflightComboStreamResponse(sse(
          { type: "response.created", response: { id: "r1", status: "in_progress" } },
          {
            type: "response.incomplete",
            response: {
              id: "r1",
              status: "incomplete",
              incomplete_details: { reason },
              usage: { input_tokens: 11, output_tokens: 0, total_tokens: 11 },
            },
          },
        ), { model: "m1", provider: "a" });

        expect(result.kind).toBe("failed");
        expect(result.response.status).toBe(status);
        const body = await result.response.json();
        expect(body.error).toMatchObject({ type: "upstream_error", code: "upstream_server_error" });
        expect(body.error.message).toContain(message);
        expect(body.response.usage).toMatchObject({ input_tokens: 11, output_tokens: 0 });
      }
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_AGENTRADAR; else process.env.OPENCODEX_AGENTRADAR = previous;
    }
  });
});
