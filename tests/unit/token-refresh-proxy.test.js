/**
 * OAuth token refresh must egress through the connection's proxy pool.
 *
 * Regression (llm.barroso.tec.br, 2026-09-18): every refresh<Provider>Token
 * used the bare global fetch with no proxyOptions, so token renewals left from
 * the host's own IP instead of the relay. It stayed silent for months because
 * these functions return null on a network error; KROUTER_REQUIRE_PROXY
 * refusing a direct egress to auth.openai.com during a Codex refresh is what
 * finally made it visible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ access_token: "new-tok", refresh_token: "new-ref", expires_in: 3600 }),
  text: async () => "",
}));

const resolveConnectionProxyConfig = vi.fn(async () => ({
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://relay:7777",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  source: "pool",
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig }));

const { refreshTokenByProvider, getAccessToken, refreshClaudeOAuthToken } = await import(
  "open-sse/services/tokenRefresh.js"
);

// dedupRefresh caches per (provider, refreshToken) for 10s, so each test needs
// its own token or it gets the previous test's cached result with no fetch.
let seq = 0;
function credentials(extra = {}) {
  return {
    refreshToken: `ref-${++seq}`,
    providerSpecificData: { proxyPoolId: "pool-abc" },
    ...extra,
  };
}

describe("tokenRefresh — proxy pool", () => {
  beforeEach(() => {
    proxyAwareFetch.mockClear();
    resolveConnectionProxyConfig.mockClear();
  });

  it("routes a Codex refresh through proxyAwareFetch with the pool's options", async () => {
    await refreshTokenByProvider("codex", credentials(), null);

    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-abc" });
    const [url, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toMatch(/openai|auth\./i);
    expect(proxyOptions).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://relay:7777",
      strictProxy: true,
    });
  });

  it("threads the pool through the second dispatcher (getAccessToken) too", async () => {
    await getAccessToken("claude", credentials(), null);

    expect(resolveConnectionProxyConfig).toHaveBeenCalled();
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions?.connectionProxyUrl).toBe("http://relay:7777");
  });

  it("prefers proxyOptions the caller passed over resolving the pool again", async () => {
    const explicit = { connectionProxyEnabled: true, connectionProxyUrl: "http://caller:1080" };
    await refreshTokenByProvider("claude", credentials(), null, explicit);

    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions).toBe(explicit);
  });

  it("still refreshes when the pool lookup throws, degrading to no proxy", async () => {
    resolveConnectionProxyConfig.mockRejectedValueOnce(new Error("db down"));
    const result = await refreshTokenByProvider("claude", credentials(), null);

    expect(result?.accessToken).toBe("new-tok");
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions).toBeNull();
  });

  it("keeps the old arity working — a direct call with no proxyOptions still refreshes", async () => {
    const result = await refreshClaudeOAuthToken(`ref-legacy-${++seq}`, null);

    expect(result?.accessToken).toBe("new-tok");
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions).toBeNull();
  });
});
