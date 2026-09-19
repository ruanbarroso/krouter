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
import { handleComboChat } from "../../open-sse/services/combo.js";

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

/**
 * 3. O mesmo 403 abortava o COMBO inteiro (medido em 2026-09-19, produção).
 *
 *    `shouldFallback:false` responde duas perguntas que não são a mesma:
 *    "tentar outra CONTA deste provedor?" (não — a credencial é a mesma em
 *    todo relay) e "tentar o próximo MODELO do combo?" (sim — é outro
 *    provedor). O `combo.js` lia o primeiro `false` como resposta à segunda
 *    e devolvia o 403 no degrau 1. Efeito medido: o combo `barroso-chat`
 *    parou de alcançar os degraus 2/3/4, e o gateway acima (barroso-keys)
 *    leu o 403 como cota, devolvendo `429 usage_limit_reached` por pedido.
 *
 *    `advanceCombo: true` separa as duas respostas — é o mesmo force-advance
 *    que o 404 `isModelNotFound` já fazia, só que pedido pela regra.
 */
describe("FreeTierError avança o combo em vez de abortá-lo", () => {
  const MSG =
    '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}';

  const log = { info() {}, warn() {}, error() {} };

  it("a regra marca advanceCombo sem reabrir o fan-out entre contas", () => {
    const r = checkFallbackError(403, MSG);
    expect(r.shouldFallback).toBe(false);
    expect(r.advanceCombo).toBe(true);
  });

  it("regras vizinhas de shouldFallback:false continuam SEM advanceCombo", () => {
    // Tamanho de entrada: o próximo degrau receberia o mesmo prompt grande.
    expect(checkFallbackError(400, "input content length exceeds").advanceCombo).toBe(false);
    expect(checkFallbackError(503, "No capacity available").advanceCombo).toBe(false);
  });

  it("o combo alcança o degrau 2 quando o degrau 1 é o free tier bloqueado", async () => {
    const tentados = [];
    const handleSingleModel = async (_body, modelStr) => {
      tentados.push(modelStr);
      if (modelStr.startsWith("oc/")) {
        return new Response(MSG, { status: 403 });
      }
      return new Response('{"ok":true}', { status: 200 });
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "oi" }] },
      models: ["oc/muse-spark-1.3-contributor-free", "gemini/gemini-3.8-flash"],
      handleSingleModel,
      log,
      comboName: "teste-freetier",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    expect(tentados).toEqual(["oc/muse-spark-1.3-contributor-free", "gemini/gemini-3.8-flash"]);
    expect(res.status).toBe(200);
  });

  it("esgotados todos os degraus, o erro que sobe ainda é o 403 honesto", async () => {
    const handleSingleModel = async () => new Response(MSG, { status: 403 });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "oi" }] },
      models: ["oc/a", "oc/b"],
      handleSingleModel,
      log,
      comboName: "teste-freetier-tudo-403",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    expect(res.status).toBe(403);
  });
});
