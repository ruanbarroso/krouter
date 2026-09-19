import fs from "node:fs";

/**
 * Fecha o banco e apaga o diretório temporário do teste.
 *
 * No Windows, `fs.rmSync` falha com EPERM enquanto o arquivo do SQLite ainda
 * está aberto, e os testes que montam um DATA_DIR descartável quebravam no
 * teardown mesmo com todas as asserções passando. Pior: vários chamavam
 * `vi.resetModules()` ANTES de limpar, o que joga fora o módulo que segura o
 * handle — depois disso ninguém mais consegue fechá-lo, porque um import novo
 * cria outro registro de módulo, sem instância.
 *
 * Por isso a ordem aqui é fechar e só então remover, e por isso esta função
 * precisa ser chamada antes de qualquer `resetModules()`.
 */
export async function closeDbAndRemove(tempDir) {
  try {
    const { getAdapterSync } = await import("@/lib/db/driver.js");
    getAdapterSync()?.close?.();
  } catch {
    // Adapter nunca inicializou (teste que não tocou o banco) ou os módulos já
    // foram resetados. Nos dois casos não há handle nosso para fechar.
  }
  // O driver guarda a instância em `global._dbAdapter` de propósito, para
  // sobreviver ao hot-reload do Next — e por isso ela sobrevive também ao
  // `vi.resetModules()`. Sem limpar aqui, o próximo teste herdaria um banco
  // FECHADO ("database is not open"). Limpar também conserta um vazamento de
  // isolamento que já existia: sem close nem reset, o segundo teste de um
  // arquivo seguia usando o banco do PRIMEIRO tempDir, ignorando o DATA_DIR
  // que ele mesmo tinha acabado de criar.
  if (global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
