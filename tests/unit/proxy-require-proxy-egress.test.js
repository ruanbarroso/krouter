/**
 * Fail-closed egress for connections with NO proxy pool.
 *
 * Regression (llm.barroso.tec.br, 2026-09-18): strictProxy is a per-pool flag,
 * so a connection without a pool resolves to `source: "none"` and carries no
 * flag at all. Those requests egressed direct from the host IP — the exact
 * thing the relay pool exists to prevent — and on a fail-closed host the
 * firewall killed them, surfacing as a bare "fetch failed" with no clue that
 * the real cause was a missing pool assignment. 845 kiro routings in 24h, 146
 * with a pool.
 *
 * KROUTER_REQUIRE_PROXY=1 makes the app refuse that direct egress itself, with
 * a message naming the host, while leaving loopback/private traffic alone
 * (the global fetch is patched, so internal calls flow through here too).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const PUBLIC_TARGET = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const DEAD_PROXY = "http://127.0.0.1:9";

describe("proxyAwareFetch — KROUTER_REQUIRE_PROXY", () => {
  beforeEach(() => {
    delete process.env.KROUTER_REQUIRE_PROXY;
  });
  afterEach(() => {
    delete process.env.KROUTER_REQUIRE_PROXY;
  });

  it("refuses direct egress to a public host when no proxy is resolved", async () => {
    process.env.KROUTER_REQUIRE_PROXY = "1";
    await expect(
      proxyAwareFetch(PUBLIC_TARGET, { method: "POST" }, {})
    ).rejects.toThrow(/Direct egress to codewhisperer\.us-east-1\.amazonaws\.com refused/);
  });

  it("names the missing pool assignment as the cause, not a network error", async () => {
    process.env.KROUTER_REQUIRE_PROXY = "1";
    await expect(
      proxyAwareFetch(PUBLIC_TARGET, { method: "POST" }, {})
    ).rejects.toThrow(/no proxy pool is assigned to this connection/);
  });

  it("is off by default — no env, no refusal (request fails as a network error)", async () => {
    await expect(
      proxyAwareFetch("https://127.0.0.1:9/nope", { method: "GET" }, {})
    ).rejects.toThrow(/ECONNREFUSED|fetch failed|connect/i);
  }, 15000);

  it.each([
    ["loopback", "http://127.0.0.1:9/health"],
    ["localhost", "http://localhost:9/health"],
    ["tailnet CGNAT", "http://100.114.162.2:9/health"],
    ["private v4", "http://10.0.0.246:9/health"],
    ["tailnet domain", "http://box.tail3fb814.ts.net:9/health"],
  ])("still allows %s with the policy on", async (_label, target) => {
    process.env.KROUTER_REQUIRE_PROXY = "1";
    // Nothing listens on :9, so these reject — but as connection errors, which
    // proves they were never refused by the egress policy.
    await expect(
      proxyAwareFetch(target, { method: "GET" }, {})
    ).rejects.not.toThrow(/Direct egress/);
  }, 15000);

  it("refuses the non-strict fallback after a proxy failure", async () => {
    process.env.KROUTER_REQUIRE_PROXY = "1";
    // Proxy is dead and strictProxy is absent, so the old code fell back to a
    // direct connection. The policy must catch that third egress point too.
    await expect(
      proxyAwareFetch("https://api.openai.com/v1/models", { method: "GET" }, {
        connectionProxyEnabled: true,
        connectionProxyUrl: DEAD_PROXY,
        connectionNoProxy: "",
      })
    ).rejects.toThrow(/Direct egress to api\.openai\.com refused/);
  }, 15000);

  it("refuses when a strictProxy pool resolved no usable proxy URL, even with the env off", async () => {
    await expect(
      proxyAwareFetch(PUBLIC_TARGET, { method: "POST" }, { strictProxy: true })
    ).rejects.toThrow(/strictProxy=true but no proxy URL survived resolution/);
  });
});
