// thinkingSignatureRecovery
//
// Reactive self-healing for stale thinking signatures on the Claude path.
//
// Even with verbatim signature passthrough, a long session can carry a
// thinking block Anthropic rejects: client-side compaction rewrites the
// thinking text while keeping the original signature, and a signature is
// only valid byte-for-byte over its exact text. The gateway cannot mint a
// valid replacement, but it CAN retry once without the thinking blocks —
// thinking history is optional context, so the retry stays on the same
// account/model instead of burning a combo fallback step (or failing the
// request when no fallback remains).

const SIGNATURE_ERROR_KEYWORDS = [
  "invalid `signature`",
  "invalid signature",
];

// High-confidence check for an Anthropic thinking-signature 400.
export function isThinkingSignatureError(status, errorBody) {
  if (status !== 400) return false;
  if (!errorBody || typeof errorBody !== "string") return false;
  const lower = errorBody.toLowerCase();
  return SIGNATURE_ERROR_KEYWORDS.some(kw => lower.includes(kw));
}

// Strip thinking/redacted_thinking blocks from Claude-shape message history.
// Keeps text, tool_use and tool_result blocks untouched so the turn still
// carries full meaning. Returns { body, stripped } — body is the original
// reference when nothing was stripped.
export function stripThinkingBlocks(body) {
  if (!body || !Array.isArray(body.messages)) return { body, stripped: 0 };
  let stripped = 0;
  const messages = body.messages.map(msg => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const kept = msg.content.filter(block => {
      if (block?.type === "thinking" || block?.type === "redacted_thinking") {
        stripped += 1;
        return false;
      }
      return true;
    });
    if (kept.length === msg.content.length) return msg;
    return { ...msg, content: kept };
  });
  if (stripped === 0) return { body, stripped: 0 };
  return { body: { ...body, messages }, stripped };
}
