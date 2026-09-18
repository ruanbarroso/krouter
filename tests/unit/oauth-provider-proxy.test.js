import { describe, it, expect, vi, beforeEach } from "vitest";

// Route every server-side OAuth call through the mocked proxy layer so the
// tests prove *routing*, never touching the network.
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

// Settings + pool resolution backing resolveOAuthProxyOptions().
vi.mock("../../src/lib/localDb", () => ({
  getSettings: vi.fn(),
}));
vi.mock("../../src/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  exchangeTokens,
  requestDeviceCode,
  pollForToken,
  generateAuthData,
  resolveOAuthProxyOptions,
} from "../../src/lib/oauth/providers.js";
import { runWithOAuthProxy } from "../../src/lib/oauth/proxyContext.js";
import { getSettings } from "../../src/lib/localDb";
import { resolveConnectionProxyConfig } from "../../src/lib/network/connectionProxy";
import { CLAUDE_CONFIG, QWEN_CONFIG } from "../../src/lib/oauth/constants/oauth.js";

const POOL_PROXY = {
  source: "pool",
  proxyPoolId: "pool-1",
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://100.115.113.33:18080",
  connectionNoProxy: "",
  strictProxy: true,
};

const okJson = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no ambient proxy, pool resolution returns "none".
  resolveConnectionProxyConfig.mockResolvedValue({
    source: "none",
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    strictProxy: false,
  });
});

describe("OAuth connect honors the provider proxy pool", () => {
  it("claude exchange goes through proxyAwareFetch with the pool options", async () => {
    proxyAwareFetch.mockResolvedValue(
      okJson({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" })
    );

    const tokens = await exchangeTokens(
      "claude", "code-1", "http://localhost:8080/callback", "verifier-1", "state-1",
      undefined, POOL_PROXY
    );

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts, proxy] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(CLAUDE_CONFIG.tokenUrl);
    expect(opts.headers["x-request-source"]).toBe("local");
    expect(proxy).toBe(POOL_PROXY);
    expect(tokens).toMatchObject({ accessToken: "a", refreshToken: "r", expiresIn: 3600 });
  });

  it("claude exchange without a pool keeps the previous direct behavior", async () => {
    const seen = [];
    vi.stubGlobal("fetch", async (url, opts) => {
      seen.push([url, opts]);
      return okJson({ access_token: "a", refresh_token: "r", expires_in: 60, scope: "s" });
    });
    try {
      const tokens = await exchangeTokens(
        "claude", "code-1", "http://localhost:8080/callback", "verifier-1", "state-1"
      );
      expect(proxyAwareFetch).not.toHaveBeenCalled();
      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toBe(CLAUDE_CONFIG.tokenUrl);
      expect(seen[0][1].headers["x-request-source"]).toBe("local");
      expect(tokens.accessToken).toBe("a");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ambient runWithOAuthProxy context routes provider calls without signature changes", async () => {
    proxyAwareFetch.mockResolvedValue(okJson({ access_token: "a" }));

    await runWithOAuthProxy(POOL_PROXY, () =>
      requestDeviceCode("qwen", "challenge-1", {})
    );

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(QWEN_CONFIG.deviceCodeUrl);
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(POOL_PROXY);
  });

  it("device-code poll routes through the pool and passes pending through", async () => {
    proxyAwareFetch.mockResolvedValue(
      okJson({ error: "authorization_pending", error_description: "waiting" })
    );

    const result = await pollForToken("qwen", "device-1", "verifier-1", undefined, POOL_PROXY);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, pending: true });
  });

  it("generateAuthData still builds the claude authorize URL (no network)", async () => {
    const auth = await generateAuthData(
      "claude", "http://localhost:8080/callback", undefined, POOL_PROXY
    );
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(auth.authUrl).toContain("https://claude.ai/oauth/authorize");
    expect(auth.authUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback");
    expect(auth.state).toBeTruthy();
    expect(auth.codeVerifier).toBeTruthy();
  });
});

describe("resolveOAuthProxyOptions", () => {
  it("returns the pool resolution for the provider strategy", async () => {
    getSettings.mockResolvedValue({ providerStrategies: { claude: { proxyPoolId: "pool-1" } } });
    resolveConnectionProxyConfig.mockResolvedValue(POOL_PROXY);

    const out = await resolveOAuthProxyOptions("claude");

    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-1" });
    expect(out).toBe(POOL_PROXY);
  });

  it("returns null when the provider has no pool configured", async () => {
    getSettings.mockResolvedValue({ providerStrategies: {} });

    expect(await resolveOAuthProxyOptions("claude")).toBeNull();
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  it("returns null when the pool resolves to no proxy", async () => {
    getSettings.mockResolvedValue({ providerStrategies: { claude: { proxyPoolId: "pool-9" } } });
    resolveConnectionProxyConfig.mockResolvedValue({
      source: "none",
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      vercelRelayUrl: "",
    });

    expect(await resolveOAuthProxyOptions("claude")).toBeNull();
  });

  it("never throws — a resolution failure means direct, as before", async () => {
    getSettings.mockRejectedValue(new Error("db locked"));

    expect(await resolveOAuthProxyOptions("claude")).toBeNull();
  });
});
