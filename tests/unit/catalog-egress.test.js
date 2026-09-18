/**
 * Model-catalog fetches must leave through the same egress path as inference.
 *
 * On a host with a fail-closed outbound firewall (llm.barroso.tec.br: the
 * `krouter` user reaches only loopback and the relays) a direct catalog fetch
 * returns "fetch failed" and the dashboard silently falls back to the static
 * model list. The three-tier precedence below is what keeps that from
 * happening, and the "never throws" contract is what keeps a proxy lookup from
 * breaking a catalog that would otherwise work.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveConnectionProxyConfig = vi.fn();
const resolveOAuthProxyOptions = vi.fn();
const proxyAwareFetch = vi.fn(async () => ({ ok: true, status: 200 }));

vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig }));
vi.mock("@/lib/oauth/providers.js", () => ({ resolveOAuthProxyOptions }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { resolveCatalogEgress, catalogFetch } = await import("@/lib/network/catalogEgress");

const POOL = { connectionProxyEnabled: true, connectionProxyUrl: "http://relay:7777" };

describe("resolveCatalogEgress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers the connection's own pool over the provider-level one", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(POOL);

    expect(await resolveCatalogEgress("kiro", { proxyPoolId: "pool-abc" })).toBe(POOL);
    expect(resolveOAuthProxyOptions).not.toHaveBeenCalled();
  });

  it("falls back to the provider-level pool when the connection has none", async () => {
    resolveOAuthProxyOptions.mockResolvedValue(POOL);

    expect(await resolveCatalogEgress("kiro", { profileArn: "arn:..." })).toBe(POOL);
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  // A connection pointing at a pool that resolves to nothing usable must not
  // shadow the provider-level pool — otherwise a half-configured connection is
  // worse than no connection config at all.
  it("falls through when the connection's pool resolves to no usable URL", async () => {
    resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "" });
    resolveOAuthProxyOptions.mockResolvedValue(POOL);

    expect(await resolveCatalogEgress("kiro", { proxyPoolId: "pool-abc" })).toBe(POOL);
  });

  it("returns null for direct egress when neither tier has a pool", async () => {
    resolveOAuthProxyOptions.mockResolvedValue(null);

    expect(await resolveCatalogEgress("nvidia", null)).toBeNull();
  });

  it("never throws — a failing lookup degrades to direct", async () => {
    resolveConnectionProxyConfig.mockRejectedValue(new Error("db down"));
    resolveOAuthProxyOptions.mockRejectedValue(new Error("db down"));

    await expect(resolveCatalogEgress("kiro", { proxyPoolId: "pool-abc" })).resolves.toBeNull();
  });
});

describe("catalogFetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes through proxyAwareFetch when given proxyOptions", async () => {
    await catalogFetch("https://api.example.com/models", { method: "GET" }, POOL);

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.example.com/models",
      { method: "GET" },
      POOL
    );
  });

  it("uses the plain fetch when there is no pool, as before this module existed", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true });

    await catalogFetch("https://api.example.com/models", {}, null);

    expect(globalFetch).toHaveBeenCalled();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });
});
