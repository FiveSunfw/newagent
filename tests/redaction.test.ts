import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/state/redaction.js";
test("events redact secret fields and environment values without discarding usage", () => {
  const previous = process.env.NEWAGENT_API_KEY;
  process.env.NEWAGENT_API_KEY = "fake-env-secret-123";
  try {
    const body = redact({
      apiKey: "fake",
      text: "header Bearer fake.token and fake-env-secret-123",
      usage: { inputTokens: 12, outputTokens: 4 },
      child: { refresh_token: "fake" },
    });
    assert.deepEqual(body, {
      apiKey: "[REDACTED]",
      text: "header Bearer [REDACTED] and [REDACTED]",
      usage: { inputTokens: 12, outputTokens: 4 },
      child: { refresh_token: "[REDACTED]" },
    });
  } finally {
    if (previous === undefined) delete process.env.NEWAGENT_API_KEY;
    else process.env.NEWAGENT_API_KEY = previous;
  }
});
