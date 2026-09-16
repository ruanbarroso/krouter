// Thinking-block handling on the Claude path.
//
// Production 2026-09-16: every multi-turn request routed to the `claude`
// provider 400'd with "Invalid `signature` in `thinking` block" (116/116
// claude errors in requestDetails, combo saved only by the kiro fallback).
// Root cause: prepareClaudeRequest stamped EVERY thinking/redacted_thinking
// block with DEFAULT_THINKING_CLAUDE_SIGNATURE, clobbering Anthropic-issued
// signatures — and history translated in from providers that mint no
// signature (e.g. kiro reasoning) can never validate either.
//
// Rules pinned here:
//   1. A present signature replays verbatim (valid byte-for-byte only).
//   2. Unsigned thinking blocks are DROPPED (forging can never validate).
//   3. redacted_thinking keeps canonical shape {type, data} — Anthropic never
//      issues signatures on redacted blocks, so any stamped one is stripped.
//   4. Thinking enabled + tool_use left without thinking after the drop, and
//      no signed thinking survives anywhere: downgrade to a non-thinking call
//      instead of injecting the fake {thinking: ".", ...} block (which 400'd
//      every time). Histories with valid chains keep thinking enabled.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";

const REAL_SIGNATURE = "EpwGCkYIBBj72sRealAnthropicSignatureFromHistory0001";

const multiTurnBody = (thinkingBlock, extra = {}) => ({
  model: "claude-opus-5",
  ...extra,
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

const thinkingBlocksOf = (out) =>
  out.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "thinking" || b.type === "redacted_thinking");

describe("prepareClaudeRequest thinking signatures (provider claude)", () => {
  it("preserves an Anthropic-issued thinking signature verbatim", () => {
    const out = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan", signature: REAL_SIGNATURE }),
      "claude"
    );
    expect(thinkingBlocksOf(out)).toHaveLength(1);
    expect(thinkingBlocksOf(out)[0].signature).toBe(REAL_SIGNATURE);
  });

  it("preserves signatures on anthropic-compatible targets too", () => {
    const out = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan", signature: REAL_SIGNATURE }),
      "anthropic-compatible-custom"
    );
    expect(thinkingBlocksOf(out)[0]?.signature).toBe(REAL_SIGNATURE);
  });

  it("drops unsigned thinking blocks instead of forging a signature", () => {
    for (const block of [
      { type: "thinking", thinking: "plan" },
      { type: "thinking", thinking: "plan", signature: "" },
    ]) {
      const out = prepareClaudeRequest(multiTurnBody(block), "claude");
      expect(thinkingBlocksOf(out)).toHaveLength(0);
      // tool_use survives the drop so the turn still executes
      const assistant = out.messages.find((m) => m.role === "assistant");
      expect(assistant.content.some((b) => b.type === "tool_use")).toBe(true);
    }
  });

  it("strips stamped signatures off redacted_thinking blocks", () => {
    const out = prepareClaudeRequest(
      multiTurnBody({ type: "redacted_thinking", data: "ENCRYPTED", signature: REAL_SIGNATURE }),
      "claude"
    );
    const blocks = thinkingBlocksOf(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].signature).toBeUndefined();
    expect(blocks[0].data).toBe("ENCRYPTED");
  });

  it("downgrades to a non-thinking call when tool_use is orphaned and nothing signed survives", () => {
    const out = prepareClaudeRequest(
      multiTurnBody(
        { type: "thinking", thinking: "kiro reasoning, no signature" },
        { thinking: { type: "enabled", budget_tokens: 1000 }, max_tokens: 2000 }
      ),
      "claude"
    );
    expect(thinkingBlocksOf(out)).toHaveLength(0);
    expect(out.thinking).toBeUndefined();
  });

  it("keeps thinking enabled when a valid chain survives elsewhere", () => {
    const out = prepareClaudeRequest(
      {
        model: "claude-opus-5",
        thinking: { type: "enabled", budget_tokens: 1000 },
        max_tokens: 2000,
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
              // unsigned: dropped, orphaning tu_9 — but sig-turn-1 survives,
              // so the client asked for thinking and keeps it.
              { type: "thinking", thinking: "foreign reasoning" },
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
    const sigs = thinkingBlocksOf(out).map((b) => b.signature);
    expect(sigs).toEqual(["sig-turn-1"]);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 1000 });
  });

  it("never injects a fake thinking block", () => {
    const out = prepareClaudeRequest(
      {
        model: "claude-opus-5",
        thinking: { type: "enabled", budget_tokens: 1000 },
        max_tokens: 2000,
        messages: [
          { role: "user", content: "run it" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_2", name: "bash", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_2", content: "done" }],
          },
        ],
      },
      "claude"
    );
    expect(JSON.stringify(out)).not.toContain('"thinking":"."');
  });

  it("leaves thinking blocks untouched for non-Claude providers", () => {
    const block = { type: "thinking", thinking: "plan", signature: REAL_SIGNATURE };
    const out = prepareClaudeRequest(multiTurnBody(block), "kiro");
    expect(thinkingBlocksOf(out)[0]?.signature).toBe(REAL_SIGNATURE);

    const unsigned = prepareClaudeRequest(
      multiTurnBody({ type: "thinking", thinking: "plan" }),
      "kiro"
    );
    expect(thinkingBlocksOf(unsigned)).toHaveLength(1);
    expect(thinkingBlocksOf(unsigned)[0].signature).toBeUndefined();
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
    expect(thinkingBlocksOf(out)[0]?.signature).toBe(REAL_SIGNATURE);
  });
});
