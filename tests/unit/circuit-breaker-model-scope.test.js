/**
 * Escopo do disjuntor (2026-09-18): google e opencode tripam POR modelo —
 * um 5xx em `gemini-3.7-flash` não cala os lites, um spark travado não cala
 * o zen. Os demais providers continuam por provider inteiro.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  isCircuitBreakerOpen,
  recordProviderSuccess,
  recordProviderFailure,
  getAllCircuitBreakerStatuses,
  _clearCircuitBreakers,
  MODEL_SCOPED_PROVIDERS,
} from "@/shared/utils/circuitBreaker.js";

const fail10 = (provider, model) => {
  let tripped = false;
  for (let i = 0; i < 10; i++) tripped = recordProviderFailure(provider, 500, model);
  return tripped;
};

describe("circuit breaker por modelo (google, opencode)", () => {
  beforeEach(() => _clearCircuitBreakers());

  it("google tripa só o modelo que falhou", () => {
    expect(fail10("google", "gemini-3.7-flash")).toBe(true);
    expect(isCircuitBreakerOpen("google", "gemini-3.7-flash")).toBe(true);
    expect(isCircuitBreakerOpen("google", "gemini-3.5-flash-lite")).toBe(false);
    // Sem modelo não enxerga o trip do modelo (chaves diferentes)
    expect(isCircuitBreakerOpen("google")).toBe(false);
  });

  it("opencode tripa só o modelo que falhou", () => {
    fail10("opencode", "muse-spark-1.2-contributor-free");
    expect(isCircuitBreakerOpen("opencode", "muse-spark-1.2-contributor-free")).toBe(true);
    expect(isCircuitBreakerOpen("opencode", "big-pickle")).toBe(false);
  });

  it("sucesso num modelo não zera o contador do outro", () => {
    for (let i = 0; i < 9; i++) recordProviderFailure("google", 500, "gemini-3.7-flash");
    for (let i = 0; i < 9; i++) recordProviderFailure("google", 500, "gemini-3.8-flash");
    recordProviderSuccess("google", "gemini-3.7-flash");
    recordProviderFailure("google", 500, "gemini-3.8-flash");
    expect(isCircuitBreakerOpen("google", "gemini-3.7-flash")).toBe(false);
    expect(isCircuitBreakerOpen("google", "gemini-3.8-flash")).toBe(true);
  });

  it("snapshot expõe provider e modelo", () => {
    fail10("google", "gemini-3.7-flash");
    const st = getAllCircuitBreakerStatuses();
    const keys = Object.keys(st);
    expect(keys.length).toBe(1);
    expect(st[keys[0]].provider).toBe("google");
    expect(st[keys[0]].model).toBe("gemini-3.7-flash");
    expect(st[keys[0]].status).toBe("open");
  });
});

describe("demais providers continuam por provider inteiro", () => {
  beforeEach(() => _clearCircuitBreakers());

  it("nvidia: falha num modelo tripa o provider (modelo ignorado)", () => {
    expect(MODEL_SCOPED_PROVIDERS.has("nvidia")).toBe(false);
    fail10("nvidia", "z-ai/glm-5.3-flash");
    expect(isCircuitBreakerOpen("nvidia")).toBe(true);
    expect(isCircuitBreakerOpen("nvidia", "outro-modelo")).toBe(true);
  });

  it("codex: sucesso sem modelo zera o contador", () => {
    for (let i = 0; i < 9; i++) recordProviderFailure("codex", 500);
    recordProviderSuccess("codex");
    recordProviderFailure("codex", 500);
    expect(isCircuitBreakerOpen("codex")).toBe(false);
  });
});
