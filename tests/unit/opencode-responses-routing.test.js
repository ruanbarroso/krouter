/**
 * OpenCode Free serves muse-spark-* ONLY on /zen/v1/responses.
 * Measured 2026-09-09: 200 on /responses, deterministic 500 on
 * /chat/completions (14/14). Everything else stays on /chat/completions.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  OpenCodeExecutor,
  isOpenCodeResponsesModel,
  resolveOpenCodeSeed,
  OPENCODE_SESSION_HEADER,
} from "../../open-sse/executors/opencode.js";

const sseBody = () => new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); },
});

const okStream = () => new Response(sseBody(), {
  status: 200, headers: { "Content-Type": "text/event-stream" },
});

let exec;
beforeEach(() => {
  exec = new OpenCodeExecutor();
  proxyAwareFetch.mockReset();
  proxyAwareFetch.mockImplementation(() => Promise.resolve(okStream()));
});
afterEach(() => { vi.restoreAllMocks(); });

const sentUrl = () => proxyAwareFetch.mock.calls[0]?.[0] || "";
const sentHeaders = () => proxyAwareFetch.mock.calls[0]?.[1]?.headers || {};
const sentBody = () => JSON.parse(proxyAwareFetch.mock.calls[0]?.[1]?.body || "{}");

const run = async (over = {}) => {
  await exec.execute({
    model: "muse-spark-1.6-contributor-free",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { connectionId: "conn-a" },
    clientTool: "claude",
    ...over,
  });
  return { url: sentUrl(), headers: sentHeaders(), body: sentBody() };
};

describe("isOpenCodeResponsesModel", () => {
  it("matches muse-spark variants case-insensitively", () => {
    expect(isOpenCodeResponsesModel("muse-spark-1.3-contributor-free")).toBe(true);
    expect(isOpenCodeResponsesModel("MUSE-SPARK-1.6")).toBe(true);
  });

  it("leaves chat-only models alone", () => {
    for (const m of ["nemotron-3-super", "ling", "big-pickle", "mimo-auto", "qwen3.6-plus"]) {
      expect(isOpenCodeResponsesModel(m)).toBe(false);
    }
  });
});

describe("OpenCode muse-spark routing", () => {
  it("posts muse-spark to /zen/v1/responses", async () => {
    const { url } = await run();
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("keeps chat-only models on /chat/completions", async () => {
    await run({ model: "nemotron-3-super" });
    expect(sentUrl()).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("sends a Responses body with the session header", async () => {
    const { headers, body } = await run();
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(headers["x-request-source"]).toBe("local");
    expect(body.model).toBe("muse-spark-1.6-contributor-free");
    expect(Array.isArray(body.input)).toBe(true);
  });

  it("is stable across turns and namespaces tools", async () => {
    const a = await run();
    proxyAwareFetch.mockClear();
    const b = await run();
    expect(b.headers[OPENCODE_SESSION_HEADER]).toBe(a.headers[OPENCODE_SESSION_HEADER]);
    proxyAwareFetch.mockClear();
    const c = await run({ clientTool: "codex" });
    expect(c.headers[OPENCODE_SESSION_HEADER]).not.toBe(a.headers[OPENCODE_SESSION_HEADER]);
  });

  it("preserves a native session and never mutates caller creds", async () => {
    const creds = { connectionId: "c", rawHeaders: { "X-OpenCode-Session": "ses_native" } };
    const { headers } = await run({ credentials: creds });
    expect(headers[OPENCODE_SESSION_HEADER]).toBe("ses_native");
    expect(creds).not.toHaveProperty("_opencodeSession");
    expect(exec).not.toHaveProperty("_opencodeSession");
  });
});

describe("seed precedence", () => {
  it("prefers explicit conversation id, then workspace", () => {
    const seed = resolveOpenCodeSeed(
      { connectionId: "conn", providerSpecificData: { workspaceId: "ws" } },
      { conversation_id: "conv-x" },
    );
    expect(seed).toBe("conv-x");
    expect(resolveOpenCodeSeed({ connectionId: "conn", providerSpecificData: { workspaceId: "ws" } }, {})).toBe("ws");
  });
});
