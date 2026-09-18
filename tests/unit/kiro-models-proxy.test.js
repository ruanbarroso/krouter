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
  // Serves both roles: the catalog response and, on the 403 path, the token
  // refresh response (refreshKiroToken is the real implementation here).
  json: async () => ({
    models: [{ modelId: "claude-sonnet-4", modelName: "Sonnet 4" }],
    accessToken: "new-tok",
    refreshToken: "new-ref",
    expiresIn: 3600,
    access_token: "new-tok",
    refresh_token: "new-ref",
    expires_in: 3600,
  }),
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
    // refreshKiroToken dedupes per refresh token, so keep it unique per case.
    refreshToken: `ref-${seq}`,
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

  it("uses proxyOptions the caller supplied instead of resolving the pool again", async () => {
    const explicit = { connectionProxyEnabled: true, connectionProxyUrl: "http://caller:1080" };
    await resolveKiroModels(credentials(), { proxyOptions: explicit });

    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions).toBe(explicit);
  });

  // AWS answers 403 for a stale bearer token on this endpoint, not 401. While
  // the catch tested only for 401, an expired token silently fell through to
  // the hardcoded catalog instead of refreshing.
  it("refreshes the token on a 403, not just a 401", async () => {
    proxyAwareFetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "The bearer token included in the request is invalid.",
    }));

    const onCredentialsRefreshed = vi.fn();
    const result = await resolveKiroModels(credentials(), { onCredentialsRefreshed });

    // 1st call = the 403, 2nd = the token refresh, 3rd = the retried catalog.
    expect(proxyAwareFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onCredentialsRefreshed).toHaveBeenCalled();
    expect(result?.models?.length).toBeGreaterThan(0);
  });

  it("still resolves the catalog when the pool lookup throws", async () => {
    resolveConnectionProxyConfig.mockRejectedValueOnce(new Error("db down"));
    const result = await resolveKiroModels(credentials());

    expect(result?.models?.length).toBeGreaterThan(0);
    const [, , proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(proxyOptions).toBeNull();
  });
});
