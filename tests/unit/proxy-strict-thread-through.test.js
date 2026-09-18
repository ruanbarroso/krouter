/**
 * strictProxy thread-through: a pool with strictProxy=true must fail hard on
 * proxy errors instead of silently falling back to direct egress.
 *
 * Regression: chatCore rebuilt proxyOptions by hand (4 legacy fields) and
 * auth.js stashed the resolved pool without the flag, so proxyAwareFetch
 * never saw strictProxy=true and every proxy failure egressed direct.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(async (id) => ({
    id,
    isActive: true,
    proxyUrl: "http://relay:token@127.0.0.1:9",
    noProxy: "",
    type: "http",
    strictProxy: true,
  })),
}));

import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const DEAD_PROXY = "http://127.0.0.1:9";
const UNREACHABLE = "https://127.0.0.1:9/nope";

describe("resolveConnectionProxyConfig — strictProxy propagation", () => {
  it("carries strictProxy:true from an http pool into proxyOptions", async () => {
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "bk-test" });
    expect(cfg.source).toBe("pool");
    expect(cfg.connectionProxyEnabled).toBe(true);
    expect(cfg.strictProxy).toBe(true);
  });

  it("defaults strictProxy to false when the pool has no flag", async () => {
    const { getProxyPoolById } = await import("@/models");
    getProxyPoolById.mockResolvedValueOnce({
      id: "bk-lax",
      isActive: true,
      proxyUrl: DEAD_PROXY,
      noProxy: "",
      type: "http",
    });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "bk-lax" });
    expect(cfg.strictProxy).toBe(false);
  });
});

describe("proxyAwareFetch — strictProxy fail-closed", () => {
  it("throws instead of falling back to direct when strictProxy=true", async () => {
    await expect(
      proxyAwareFetch(UNREACHABLE, { method: "GET" }, {
        connectionProxyEnabled: true,
        connectionProxyUrl: DEAD_PROXY,
        connectionNoProxy: "",
        strictProxy: true,
      })
    ).rejects.toThrow("strictProxy=true");
  }, 15000);

  it("still falls back to direct when strictProxy is absent", async () => {
    // Both proxy and direct target are dead (127.0.0.1:9 refuses), so the
    // request still rejects — but with a connection error, proving the
    // direct fallback path ran instead of the strict throw.
    await expect(
      proxyAwareFetch(UNREACHABLE, { method: "GET" }, {
        connectionProxyEnabled: true,
        connectionProxyUrl: DEAD_PROXY,
        connectionNoProxy: "",
      })
    ).rejects.toThrow(/ECONNREFUSED|fetch failed|connect/i);
  }, 15000);
});
