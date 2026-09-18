/**
 * Upstream lento não é proxy quebrado: o timer de headers dos executores
 * aborta o fetch quando o UPSTREAM não responde a tempo, e sob strictProxy
 * isso saía no log como "Proxy required but failed" — mandando toda
 * investigação para a camada errada (2026-09-18: relays íntegros com
 * credencial válida, NVIDIA lenta; 100% das tentativas rotuladas como
 * falha de proxy). Fail-closed continua valendo; só o rótulo muda.
 */
import { describe, it, expect } from "vitest";

import {
  proxyAwareFetch,
  isUpstreamHeadersTimeout,
  newUpstreamHeadersTimeoutError,
} from "open-sse/utils/proxyFetch.js";

const DEAD_PROXY = "http://127.0.0.1:9";
const UNREACHABLE = "https://127.0.0.1:9/nope";

const strictDead = {
  connectionProxyEnabled: true,
  connectionProxyUrl: DEAD_PROXY,
  connectionNoProxy: "",
  strictProxy: true,
};

const abortedWith = (err) => AbortSignal.abort(err);

describe("isUpstreamHeadersTimeout", () => {
  it("casa o erro marcado pelo timer", () => {
    expect(isUpstreamHeadersTimeout(newUpstreamHeadersTimeoutError())).toBe(true);
  });

  it("casa a mensagem legada de quem aborta com Error puro", () => {
    expect(isUpstreamHeadersTimeout(new Error("fetch connect timeout"))).toBe(true);
  });

  it("não casa AbortError de cliente, nulo nem erro de proxy", () => {
    expect(isUpstreamHeadersTimeout(new DOMException("This operation was aborted", "AbortError"))).toBe(false);
    expect(isUpstreamHeadersTimeout(null)).toBe(false);
    expect(isUpstreamHeadersTimeout(new Error("fetch failed"))).toBe(false);
  });
});

describe("proxyAwareFetch — timeout de upstream sob strictProxy", () => {
  it("rotula timeout de upstream em vez de falha de proxy (fail-closed mantido)", async () => {
    await expect(
      proxyAwareFetch(UNREACHABLE, { method: "GET", signal: abortedWith(newUpstreamHeadersTimeoutError()) }, strictDead)
    ).rejects.toThrow(/Upstream timed out waiting for response headers/);
  }, 15000);

  it("vale para a forma legada do motivo do abort", async () => {
    await expect(
      proxyAwareFetch(UNREACHABLE, { method: "GET", signal: abortedWith(new Error("fetch connect timeout")) }, strictDead)
    ).rejects.toThrow(/Upstream timed out/);
  }, 15000);

  it("falha de proxy de verdade continua com o rótulo de proxy", async () => {
    await expect(
      proxyAwareFetch(UNREACHABLE, { method: "GET" }, strictDead)
    ).rejects.toThrow(/Proxy required but failed/);
  }, 15000);

  it("sem strict, o abort de timeout cai no direto (sem rótulo strict)", async () => {
    await expect(
      proxyAwareFetch(
        UNREACHABLE,
        { method: "GET", signal: abortedWith(newUpstreamHeadersTimeoutError()) },
        { ...strictDead, strictProxy: false }
      )
    ).rejects.toThrow(/fetch connect timeout/);
  }, 15000);
});
