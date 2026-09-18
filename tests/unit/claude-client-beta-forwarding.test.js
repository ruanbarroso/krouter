/**
 * Client anthropic-beta forwarding (advisor-tool-2026-03-01 and friends).
 *
 * Regression: DefaultExecutor.buildHeaders() replaced the upstream
 * Anthropic-Beta with a static per-model list, so any client-sent
 * experimental beta (e.g. advisor-tool-2026-03-01 from Claude Code 2.1.2xx)
 * never reached Anthropic and the request 400'd with:
 *   tools.N: Input tag 'advisor_20260301' … does not match any of the
 *   expected tags
 * The gateway must union the client's flags into the upstream header.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectAnthropicBeta, mergeAnthropicBetas, parseBetaFlags } from "open-sse/config/providers.js";

describe("parseBetaFlags / mergeAnthropicBetas", () => {
  it("parses a raw header into clean flags", () => {
    expect(parseBetaFlags("a-1, b-2 ,,")).toEqual(["a-1", "b-2"]);
    expect(parseBetaFlags("")).toEqual([]);
    expect(parseBetaFlags(null)).toEqual([]);
  });

  it("unions static and client flags without duplicates", () => {
    const base = selectAnthropicBeta("claude-opus-5");
    const merged = mergeAnthropicBetas(base, ["advisor-tool-2026-03-01", "oauth-2025-04-20"]);
    expect(merged).toContain("advisor-tool-2026-03-01");
    // oauth-2025-04-20 already in base: exactly once
    expect(merged.split(",").filter(f => f === "oauth-2025-04-20")).toHaveLength(1);
    // static order preserved first
    expect(merged.startsWith(base.split(",")[0])).toBe(true);
  });

  it("is a no-op without client flags", () => {
    const base = selectAnthropicBeta("claude-haiku-4-5");
    expect(mergeAnthropicBetas(base, [])).toBe(base);
    expect(mergeAnthropicBetas(base)).toBe(base);
  });
});

describe("DefaultExecutor.buildHeaders() — client beta merge (claude)", () => {
  let DefaultExecutor;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("forwards advisor-tool beta sent by the client", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, true, null, "claude-opus-5", {
      clientBetaFlags: ["advisor-tool-2026-03-01"],
    });
    expect(headers["Anthropic-Beta"]).toContain("advisor-tool-2026-03-01");
    // static flags still present
    expect(headers["Anthropic-Beta"]).toContain("claude-code-20250219");
    expect(headers["Anthropic-Beta"]).toContain("effort-2025-11-24");
  });

  it("keeps the static list untouched when the client sends nothing", () => {
    const executor = new DefaultExecutor("claude");
    const plain = executor.buildHeaders({ apiKey: "k" }, true, null, "claude-opus-5");
    const merged = executor.buildHeaders({ apiKey: "k" }, true, null, "claude-opus-5", { clientBetaFlags: [] });
    expect(merged["Anthropic-Beta"]).toBe(plain["Anthropic-Beta"]);
  });

  it("dedupes flags the client repeats from the static list", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, true, null, "claude-opus-5", {
      clientBetaFlags: ["claude-code-20250219", "advisor-tool-2026-03-01"],
    });
    const flags = headers["Anthropic-Beta"].split(",");
    expect(flags.filter(f => f === "claude-code-20250219")).toHaveLength(1);
    expect(flags).toContain("advisor-tool-2026-03-01");
  });
});
