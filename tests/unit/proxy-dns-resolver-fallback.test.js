/**
 * MITM-bypass DNS: configurable servers + system-resolver fallback.
 *
 * Regression (llm.barroso.tec.br, 2026-09-18): resolveRealIP() hardcoded
 * 8.8.8.8/8.8.4.4. On a host whose egress firewall only permits the local stub
 * and the relays, every bypass resolve died with ECONNREFUSED — 271 warnings
 * in a 27-minute window, all noise, because the caller then fell through to a
 * direct connection the firewall killed anyway.
 *
 * The fallback must not reopen the hole the bypass exists to close: a stub
 * resolver synthesizes /etc/hosts, so a loopback answer is the MITM spoof and
 * has to be refused rather than cached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setServers = vi.fn();
const explicitResolve4 = vi.fn();
const systemResolve4 = vi.fn();

vi.mock("dns", () => {
  class Resolver {
    setServers(...args) {
      setServers(...args);
    }
    resolve4(...args) {
      return explicitResolve4(...args);
    }
  }
  const resolve4 = (hostname, cb) => systemResolve4(hostname, cb);
  return { default: { Resolver, resolve4 }, Resolver, resolve4 };
});

// Import after the mock so the module picks it up.
const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

// A MITM_BYPASS_HOSTS entry with no proxy configured drives resolveRealIP.
// shouldBypassMitmDns() matches by substring, so a unique label still counts as
// a bypass host — and it has to be unique, because resolveRealIP memoises into
// a module-level DNS_CACHE that outlives vi.clearAllMocks().
let bypassSeq = 0;
function freshBypassTarget() {
  return `https://t${++bypassSeq}.api.anthropic.com/v1/messages`;
}

function nodeback(result, error) {
  return (_hostname, cb) => (error ? cb(error) : cb(null, result));
}

describe("resolveRealIP — servers and fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KROUTER_DNS_SERVERS;
    delete process.env.KROUTER_REQUIRE_PROXY;
  });
  afterEach(() => {
    delete process.env.KROUTER_DNS_SERVERS;
    delete process.env.KROUTER_REQUIRE_PROXY;
  });

  it("defaults to public DNS when KROUTER_DNS_SERVERS is unset", async () => {
    explicitResolve4.mockImplementation(nodeback(["160.79.104.10"]));
    await proxyAwareFetch(freshBypassTarget(), { method: "POST" }, {}).catch(() => {});
    expect(setServers).toHaveBeenCalledWith(["8.8.8.8", "8.8.4.4"]);
  });

  it("honours KROUTER_DNS_SERVERS", async () => {
    process.env.KROUTER_DNS_SERVERS = "127.0.0.53, 1.1.1.1";
    explicitResolve4.mockImplementation(nodeback(["160.79.104.10"]));
    await proxyAwareFetch(freshBypassTarget(), { method: "POST" }, {}).catch(() => {});
    expect(setServers).toHaveBeenCalledWith(["127.0.0.53", "1.1.1.1"]);
  });

  it("falls back to the system resolver when the explicit servers are unreachable", async () => {
    const refused = Object.assign(new Error("queryA ECONNREFUSED"), { code: "ECONNREFUSED" });
    explicitResolve4.mockImplementation(nodeback(null, refused));
    systemResolve4.mockImplementation(nodeback(["160.79.104.10"]));
    await proxyAwareFetch(freshBypassTarget(), { method: "POST" }, {}).catch(() => {});
    expect(systemResolve4).toHaveBeenCalled();
  });

  it("refuses a loopback answer from the system resolver — that is the MITM spoof", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = Object.assign(new Error("queryA ECONNREFUSED"), { code: "ECONNREFUSED" });
    explicitResolve4.mockImplementation(nodeback(null, refused));
    systemResolve4.mockImplementation(nodeback(["127.0.0.1"]));

    await proxyAwareFetch(freshBypassTarget(), { method: "POST" }, {}).catch(() => {});

    const messages = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(messages).toMatch(/refusing loopback answer 127\.0\.0\.1/);
    warn.mockRestore();
  });
});
