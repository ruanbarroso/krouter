import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-alias-enable-"));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = { instance: null, initPromise: null, logged: true };
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter().catch(() => null))?.close?.();
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
  if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function putAlias(model, alias) {
  return new Request("https://router.local/api/models/alias", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, alias }),
  });
}

function postCustom(providerAlias, id) {
  return new Request("https://router.local/api/models/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerAlias, id, type: "llm", name: id }),
  });
}

describe("add-model clears disabled", () => {
  it("PUT /api/models/alias re-enables a disabled hardcoded model", async () => {
    await db.disableModels("kr", ["claude-haiku-4.5"]);
    expect(await db.getDisabledByProvider("kr")).toContain("claude-haiku-4.5");

    const { PUT } = await import("@/app/api/models/alias/route.js");
    const res = await PUT(putAlias("kr/claude-haiku-4.5", "claude-haiku-4.5"));
    expect(res.status).toBe(200);

    expect(await db.getDisabledByProvider("kr")).not.toContain("claude-haiku-4.5");
    expect((await db.getModelAliases())["claude-haiku-4.5"]).toBe("kr/claude-haiku-4.5");
  });

  it("POST /api/models/custom re-enables a disabled model id", async () => {
    await db.disableModels("cc", ["claude-opus-5"]);

    const { POST } = await import("@/app/api/models/custom/route.js");
    const res = await POST(postCustom("cc", "claude-opus-5"));
    expect(res.status).toBe(200);

    expect(await db.getDisabledByProvider("cc")).not.toContain("claude-opus-5");
  });
});
