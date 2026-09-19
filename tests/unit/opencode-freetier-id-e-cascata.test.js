/**
 * Dois defeitos do caminho opencode, medidos em 2026-09-19.
 *
 * 1. Id de sessão na forma errada. O upstream
 *    (packages/opencode/src/id/id.ts) emite `ses` em ordem DECRESCENTE
 *    (`~n & 2^48-1`) e `msg` em ordem crescente (`n & 2^48-1`), com
 *    n = Date.now() * 0x1000 + counter. O fork mintava ambos crescentes.
 *    Os valores esperados aqui vêm de uma captura do cliente oficial:
 *      ses_f463a94adffewjl4kBHeFNTBhc
 *      msg_0b9c56b7f001xaBXGnJwJdUEjB
 *    emitidos na mesma sessão, 45 ms um do outro.
 *
 *    NB: o truncamento para 48 bits NÃO é um bug — é o formato. O id real
 *    acima decodifica para 1971 pelo mesmo motivo.
 *
 * 2. Cascata no 403 do free tier. "FreeTierError: OpenCode's free tier can
 *    only be used from within OpenCode" é uma decisão sobre o conteúdo do
 *    pedido, idêntica em qualquer credencial. Caindo na regra genérica de
 *    status 403 (cooldown 120 s + fallback), um único pedido queimava as 12
 *    contas e deixava modelLock_* de 2 min em cada uma, derrubando tráfego
 *    limpo de outros modelos do mesmo provedor.
 */
import { describe, expect, it } from "vitest";
import { mintOpenCodeId, openCodeSessionId } from "../../open-sse/executors/opencode.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const MASK = 0xffffffffffffn;
const hexOf = (id) => id.slice(id.indexOf("_") + 1, id.indexOf("_") + 13);

describe("mintOpenCodeId — ascendente x descendente", () => {
  it("reproduz o par ses/msg capturado do cliente oficial", () => {
    // ~msg deve bater com ses a menos dos 45 ms entre um e outro.
    const msg = 0x0b9c56b7f001n;
    const ses = 0xf463a94adffen;
    const derivado = (~msg) & MASK;
    // 7 dígitos hex idênticos: o resto é a diferença de tempo.
    expect(derivado.toString(16).slice(0, 7)).toBe(ses.toString(16).slice(0, 7));
    // e a diferença, decodificada, são exatamente 45 ms.
    expect(Number((((~ses) & MASK) - msg) / 0x1000n)).toBe(-45);
  });

  it("msg é crescente e ses é decrescente", () => {
    const msg = BigInt(`0x${hexOf(mintOpenCodeId("msg", "seed"))}`);
    const ses = BigInt(`0x${hexOf(mintOpenCodeId("ses", "seed", { descending: true }))}`);
    // No mesmo milissegundo, um é o complemento do outro em 48 bits — a
    // folga de 0x2000 cobre o counter e a virada de ms entre as duas chamadas.
    const delta = ((~ses) & MASK) - msg;
    expect(delta >= -0x2000n && delta <= 0x2000n).toBe(true);
    // O ascendente hoje começa com 0; o descendente, com f.
    expect(hexOf(mintOpenCodeId("msg", "s"))[0]).toBe("0");
    expect(hexOf(mintOpenCodeId("ses", "s", { descending: true }))[0]).toBe("f");
  });

  it("openCodeSessionId emite a forma decrescente", () => {
    const id = openCodeSessionId({ credentials: { connectionId: "c1" } });
    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(hexOf(id)[0]).toBe("f");
  });

  it("desempata ids emitidos no mesmo milissegundo", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintOpenCodeId("msg", "mesmo-seed")));
    expect(ids.size).toBe(50);
  });
});

describe("FreeTierError não cascateia", () => {
  const MSG =
    '{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode"}}';

  it("para na primeira conta e não esfria nenhuma", () => {
    const r = checkFallbackError(403, MSG);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(r.accountLock).toBe(false);
  });

  it("casa pelo tipo do erro mesmo sem a frase completa", () => {
    const r = checkFallbackError(403, "FreeTierError");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("um 403 genérico continua caindo na regra de status (120 s + fallback)", () => {
    const r = checkFallbackError(403, "Forbidden");
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBe(2 * 60 * 1000);
  });
});
