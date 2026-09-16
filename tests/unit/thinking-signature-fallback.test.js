import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// 0.5.160 — Invalid thinking signature is a deterministic PER-REQUEST error:
// the history carries a thinking block whose signature Anthropic rejects
// (stale after client-side compaction, or minted by another provider).
// Locking the account on it short-circuits UNRELATED clean requests with a
// cached 400 (production 2026-09-16: the single claude account sat in
// near-permanent cooldown, clean single-turn calls failed for ~30s windows).
// So: no cooldown — but DO fall through to the next combo model (kiro does
// not validate signatures and serves these sessions fine).
describe("invalid thinking signature (no account cooldown, keep fallback)", () => {
  it("Anthropic message shape — Invalid `signature` in `thinking` block", () => {
    const r = checkFallbackError(
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.12: Invalid `signature` in `thinking` block"}}',
    );
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBe(0);
  });

  it("matches case-insensitively without backticks", () => {
    const r = checkFallbackError(400, "Invalid signature in thinking block");
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBe(0);
  });

  it("unrelated 400 still cools down (backwards compat)", () => {
    const r = checkFallbackError(400, '{"error":"something else"}');
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
  });
});
