/**
 * Quota preflight must egress through the connection's proxy pool.
 *
 * Regression (llm.barroso.tec.br, 2026-09-18): fetchAndCache() called
 * getUsageForProvider(connection) with no proxyOptions, so every quota poll
 * hit codewhisperer/q.us-east-1 from the host's own IP — the exact thing the
 * relay pool exists to prevent. It was invisible because fetchAndCache wraps
 * the call in `catch { return null }`; only KROUTER_REQUIRE_PROXY refusing a
 * direct egress to q.us-east-1.amazonaws.com exposed it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getUsageForProvider = vi.fn(async () => ({}));
const resolveConnectionProxyConfig = vi.fn(async () => ({
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://relay:7777",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  source: "pool",
}));

vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig }));

const { forceRefreshQuota } = await import("open-sse/services/quotaPreflight.js");

const CONNECTION = {
  id: "conn-kiro-1",
  provider: "kiro",
  accessToken: "tok",
  providerSpecificData: { proxyPoolId: "pool-abc" },
};

describe("quotaPreflight — proxy pool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUsageForProvider.mockResolvedValue({});
  });

  it("resolves the connection's pool and passes proxyOptions to the usage call", async () => {
    await forceRefreshQuota("kiro", CONNECTION.id, CONNECTION);

    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-abc" });
    const [, proxyOptions] = getUsageForProvider.mock.calls[0];
    expect(proxyOptions).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://relay:7777",
    });
  });

  it("carries the pool's strictProxy flag instead of hardcoding false", async () => {
    await forceRefreshQuota("kiro", CONNECTION.id, CONNECTION);
    const [, proxyOptions] = getUsageForProvider.mock.calls[0];
    expect(proxyOptions.strictProxy).toBe(true);
  });

  it("degrades to null proxyOptions when the pool lookup throws, without failing the poll", async () => {
    resolveConnectionProxyConfig.mockRejectedValueOnce(new Error("db down"));
    await expect(forceRefreshQuota("kiro", CONNECTION.id, CONNECTION)).resolves.not.toThrow();
    const [, proxyOptions] = getUsageForProvider.mock.calls[0];
    expect(proxyOptions).toBeNull();
  });
});
