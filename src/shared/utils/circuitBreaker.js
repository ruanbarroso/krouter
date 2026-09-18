// circuitBreaker (0.5.30; escopo por modelo em google/opencode desde 2026-09-18)
//
// Disjuntor contra upstream em pane, complementar aos model locks por conta.
// Tripa após 10 5xx consecutivos e bloqueia novas requisições por 5 min.
//
// GRANULARIDADE: google e opencode (zen) tripam POR (provider, modelo) — um
// 5xx em `gemini-3.7-flash` não pode calar os lites saudáveis, e um spark
// travado não pode calar o resto do zen (medido em produção 2026-09-18: o
// breaker do provider inteiro abria por um modelo só). Os demais providers
// continuam por provider: uma chave, um destino, mesma população de falha.
const breakers = new Map();

const THRESHOLD = 10;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min

// Providers cuja falha varia por modelo (frota de modelos independentes atrás
// da mesma etiqueta), não por provider inteiro.
export const MODEL_SCOPED_PROVIDERS = new Set(["google", "opencode"]);

function keyFor(provider, model) {
  if (provider && model && MODEL_SCOPED_PROVIDERS.has(provider)) return JSON.stringify([provider, model]);
  return provider;
}

function splitKey(key) {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed)) return { provider: parsed[0], model: parsed[1] ?? null };
  } catch { /* chave legada por provider: cai no retorno abaixo */ }
  return { provider: key, model: null };
}

function ensureBreaker(key) {
  let b = breakers.get(key);
  if (!b) {
    b = { consecutiveFailures: 0, trippedUntil: null };
    breakers.set(key, b);
  }
  return b;
}

export function isCircuitBreakerOpen(provider, model = null) {
  if (!provider) return false;
  const b = breakers.get(keyFor(provider, model));
  if (!b || !b.trippedUntil) return false;
  if (Date.now() > b.trippedUntil) {
    // Cooldown expired — enter half-open state
    b.trippedUntil = null;
    return false;
  }
  return true;
}

export function recordProviderSuccess(provider, model = null) {
  if (!provider) return;
  const b = ensureBreaker(keyFor(provider, model));
  b.consecutiveFailures = 0;
  b.trippedUntil = null;
}

export function recordProviderFailure(provider, status, model = null) {
  if (!provider) return;
  // We only count 5xx server errors as provider failure.
  // 429s are handled by account locks; 400s are bad requests.
  if (status < 500 || status >= 600) return;

  const b = ensureBreaker(keyFor(provider, model));
  b.consecutiveFailures++;

  if (b.consecutiveFailures >= THRESHOLD) {
    b.trippedUntil = Date.now() + COOLDOWN_MS;
    return true; // Just tripped
  }
  return false;
}

export function getAllCircuitBreakerStatuses() {
  const now = Date.now();
  const out = {};
  for (const [key, b] of breakers.entries()) {
    const { provider, model } = splitKey(key);
    if (b.trippedUntil && b.trippedUntil > now) {
      out[key] = { provider, model, status: "open", resetsInMs: b.trippedUntil - now };
    } else if (b.consecutiveFailures > 0) {
      out[key] = { provider, model, status: "half-open", failures: b.consecutiveFailures };
    } else {
      out[key] = { provider, model, status: "closed" };
    }
  }
  return out;
}

// For tests
export function _clearCircuitBreakers() {
  breakers.clear();
}
