/**
 * The Kiro model catalog must be fetched through the connection's proxy pool.
 *
 * Third caller found the same way as the other two (llm.barroso.tec.br,
 * 2026-09-18): once quotaPreflight and tokenRefresh were routed through the
 * pool, KROUTER_REQUIRE_PROXY kept refusing q.us-east-1.amazonaws.com — the
 * remaining offender was ListAvailableModels, still on the bare global fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ models: [{ modelId: "claude-sonnet-4", modelName: "Sonnet 4" }] }),
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

const { resolveKiroModels, clearKiroModelCache } = await import(
  "open-sse/services/kiroModels.js"
);

// The catalog is memoised for 5 minutes per credential, so each case needs its
// own profileArn or it gets a cache hit and never fetches.
let seq = 0;
function credentials() {
  return {
    accessToken: "tok",
    refreshToken: "ref",
    providerSpecificData: {
      proxyPoolId: "pool-abc",
      profileArn: `arn:aws:codewhisperer:us-east-1:00000000000${++seq}:profile/P${seq}`,
    },
  };
}

describe("kiroModels — proxy pool", () => {
  beforeEach(() => {
    clearKiroModelCache();
    proxyAwareFetch.mockClear();
    resolveConnectionProxyConfig.mockClear();
  });

  it("fetches ListAvailableModels through the pool, not the bare fetch", async () => {
    await resolveKiroModels(credentials());

    expect(resolveConnectionProxyConfig).toHaveBeenCalled();
    const [url, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toContain("q.us-east-1.amazonaws.com/ListAvailableModels");
    expect(proxyOptions).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://relay:7777",
      strictProxy: true,
    });
  });

  it("still resolves the catalog when the pool lookup throws", async () => {
    resolveConnectionProxyConfig.mockRejectedValueOnce(new Error("db down"));
    const result = await resolveKiroModels(credentials());

    expect(result?.models?.length).toBeGreaterThan(0);
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions).toBeNull();
  });
});
