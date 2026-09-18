import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// 2026-09-18 — O Gemini recusa imagem que não processa com 400
// ("Unable to process input image", INVALID_ARGUMENT) e cada uma travava a
// conta 30 s (modelLock), punindo tráfego limpo em rajada de vision
// (~300/h medidas). O pedido é o problema, não a conta: sem lock, com
// fallback para o próximo modelo (igual à thinking signature).
describe("image-rejection errors (no account lock, keep fallback)", () => {
  it("mensagem medida do Gemini — Unable to process input image", () => {
    const r = checkFallbackError(
      400,
      `Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting`,
    );
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBe(0);
  });

  it("casa dentro do envelope de erro completo", () => {
    const r = checkFallbackError(
      400,
      JSON.stringify({ error: { code: 400, message: "Unable to process input image.", status: "INVALID_ARGUMENT" } }),
    );
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBe(0);
  });

  it("400 genérico continua com cooldown transitório (sem virar passe-livre)", () => {
    const r = checkFallbackError(400, '{"error":"something else"}');
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
  });
});
