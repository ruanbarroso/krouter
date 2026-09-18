/**
 * Reactive recovery for stale thinking signatures.
 *
 * Production: long Claude sessions (100+ msgs) 400 with
 *   Invalid `signature` in `thinking` block
 * after client-side compaction rewrites thinking text — the original
 * signature only validates byte-for-byte. The gateway cannot mint a
 * replacement, so base.js retries once with thinking blocks stripped.
 */

import { describe, it, expect } from "vitest";
import {
  isThinkingSignatureError,
  stripThinkingBlocks,
} from "open-sse/services/thinkingSignatureRecovery.js";

const SIG_400 = '{"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.6: Invalid `signature` in `thinking` block"}}';

describe("isThinkingSignatureError", () => {
  it("matches the Anthropic invalid-signature 400", () => {
    expect(isThinkingSignatureError(400, SIG_400)).toBe(true);
  });

  it("ignores non-400 statuses", () => {
    expect(isThinkingSignatureError(429, SIG_400)).toBe(false);
    expect(isThinkingSignatureError(500, SIG_400)).toBe(false);
  });

  it("ignores unrelated 400 bodies", () => {
    expect(isThinkingSignatureError(400, '{"error":{"message":"tools.1: extra inputs not permitted"}}')).toBe(false);
  });

  it("handles missing/non-string bodies", () => {
    expect(isThinkingSignatureError(400, "")).toBe(false);
    expect(isThinkingSignatureError(400, null)).toBe(false);
    expect(isThinkingSignatureError(400, undefined)).toBe(false);
  });
});

describe("stripThinkingBlocks", () => {
  const thinking = { type: "thinking", thinking: "hmm", signature: "sig123" };
  const redacted = { type: "redacted_thinking", data: "xyz" };
  const text = { type: "text", text: "hello" };
  const toolUse = { type: "tool_use", id: "a1", name: "bash", input: {} };

  it("removes thinking and redacted_thinking, keeps everything else", () => {
    const body = {
      model: "claude-opus-5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [thinking, text, toolUse, redacted] },
      ],
    };
    const { body: out, stripped } = stripThinkingBlocks(body);
    expect(stripped).toBe(2);
    expect(out.messages[1].content).toEqual([text, toolUse]);
    // input untouched
    expect(body.messages[1].content).toHaveLength(4);
  });

  it("returns the original reference when nothing was stripped", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const { body: out, stripped } = stripThinkingBlocks(body);
    expect(stripped).toBe(0);
    expect(out).toBe(body);
  });

  it("passes through bodies without a messages array", () => {
    expect(stripThinkingBlocks(null)).toEqual({ body: null, stripped: 0 });
    expect(stripThinkingBlocks({ model: "m" })).toEqual({ body: { model: "m" }, stripped: 0 });
  });
});
