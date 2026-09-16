// Thinking-block signatures on the Claude path must round-trip verbatim.
//
// Production 2026-09-16: every multi-turn request routed to the `claude`
// provider 400'd with "Invalid `signature` in `thinking` block" (116/116
// claude errors in requestDetails, combo saved only by the kiro fallback).
// Root cause: prepareClaudeRequest stamped EVERY thinking/redacted_thinking
// block with DEFAULT_THINKING_CLAUDE_SIGNATURE, clobbering the
// Anthropic-issued signature the client replayed from history. An Anthropic
// signature is only valid byte-for-byte, so the constant never validates.
//
// Rule pinned here: preserve a present signature, fill the fallback constant
// only when the block carries none.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

const REAL_SIGNATURE = "EpwGCkYIBBj72sRealAnthropicSignatureFromHistory0001";

const multiTurnBody = (thinkingBlock) => ({
  model: "claude-opus-5",
  messages: [
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: [
        thinkingBlock,
        { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a.txt" }],
    },
  ],
});

const thinkingOf = (out, index = 0) =>
  out.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "thinking" || b.type === "redacted_thinking")[index];

describe("prepareClaudeRequest thinking signatures (provider claude)", () => {
  it("preserves an Anthropic-issued thinking signature verbatim", () => {
    const out = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan", signature: REAL_SIGNATURE }),
      "claude"
    );
    expect(thinkingOf(out)?.signature).toBe(REAL_SIGNATURE);
  });

  it("preserves signatures on anthropic-compatible targets too", () => {
    const out = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan", signature: REAL_SIGNATURE }),
      "anthropic-compatible-custom"
    );
    expect(thinkingOf(out)?.signature).toBe(REAL_SIGNATURE);
  });

  it("preserves redacted_thinking signatures", () => {
    const out = prepareClaudeRequest(
      multiTurnBody({ type: "redacted_thinking", data: "ENCRYPTED", signature: REAL_SIGNATURE }),
      "claude"
    );
    const block = thinkingOf(out);
    expect(block?.signature).toBe(REAL_SIGNATURE);
    expect(block?.data).toBe("ENCRYPTED");
  });

  it("fills the fallback constant only when the block has no signature", () => {
    const missing = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan" }),
      "claude"
    );
    expect(thinkingOf(missing)?.signature).toBe(DEFAULT_THINKING_CLAUDE_SIGNATURE);

    const empty = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan", signature: "" }),
      "claude"
    );
    expect(thinkingOf(empty)?.signature).toBe(DEFAULT_THINKING_CLAUDE_SIGNATURE);
  });

  it("leaves thinking blocks untouched for non-Claude providers", () => {
    const block = { type: "thinking", thinking: "plan", signature: REAL_SIGNATURE };
    const out = prepareClaudeRequest(multiTurnBody(block), "kiro");
    expect(thinkingOf(out)?.signature).toBe(REAL_SIGNATURE);

    const unsigned = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan" }),
      "kiro"
    );
    expect(thinkingOf(unsigned)?.signature).toBeUndefined();
  });

  it("preserves signatures across several assistant turns", () => {    const out = prepareClaudeRequest(
      {
        model: "claude-opus-5",
        messages: [
          { role: "user", content: "a" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "t1", signature: "sig-turn-1" },
              { type: "text", text: "r1" },
            ],
          },
          { role: "user", content: "b" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "t2", signature: "sig-turn-2" },
              { type: "tool_use", id: "tu_9", name: "read", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_9", content: "ok" }],
          },
        ],
      },
      "claude"
    );
    const blocks = out.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "thinking");
    expect(blocks.map((b) => b.signature).sort()).toEqual(["sig-turn-1", "sig-turn-2"]);
  });

  it("survives the full translateRequest CLAUDE→CLAUDE pipeline to provider claude", () => {
    // prepareClaudeRequest runs for every CLAUDE-target request (index.js),
    // even native passthrough — this is the exact path production 400'd on.
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "claude-opus-5",
      multiTurnBody({ type: "thinking", thinking: "plan", signature: REAL_SIGNATURE }),
      true,
      null,
      "claude"
    );
    expect(thinkingOf(out)?.signature).toBe(REAL_SIGNATURE);
  });
});
