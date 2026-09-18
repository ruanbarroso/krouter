/**
 * oc/union-alpha serves ONLY /zen/v1/messages (Anthropic shape) — the opencode
 * frontend uses it with @ai-sdk/anthropic. Posting it to /chat/completions
 * 500s on every account (measured 2026-09-18). The executor must translate
 * OpenAI→Claude on the way out and back, like the github /v1/messages shim.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
// Side-effect import: registers all translators (index.js uses bundler-only
// require() which no-ops under vitest).
import "../translator/registerAll.js";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

import { OpenCodeExecutor } from "open-sse/executors/opencode.js";

const CREDS = { accessToken: "public", connectionId: "conn-u1", id: "conn-u1" };
const CHAT_BODY = {
  model: "union-alpha",
  messages: [{ role: "user", content: "Reply with exactly: PROBE_OK" }],
  max_tokens: 20,
  stream: false,
};

function anthropicSSE() {
  const events = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_u1","type":"message","role":"assistant","model":"union-alpha","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"UNION_OK"}}',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ].join("\n");
  return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  proxyFetchMock.mockReset();
});

describe("OpenCodeExecutor endpoint routing", () => {
  it("sends union-alpha to /zen/v1/messages", async () => {
    proxyFetchMock.mockResolvedValue(anthropicSSE());
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("union-alpha")).toBe("https://opencode.ai/zen/v1/messages");
    const { response } = await ex.execute({
      model: "union-alpha", body: CHAT_BODY, stream: false,
      credentials: CREDS, signal: null, log: null, proxyOptions: null,
    });
    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://opencode.ai/zen/v1/messages");
  });

  it("keeps other models on /chat/completions", () => {
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("union-alpha")).toContain("/messages");
    expect(ex.buildUrl("nemotron-3-ultra-free")).toBe("https://opencode.ai/zen/v1/chat/completions");
  });
});

describe("OpenCodeExecutor union-alpha translation", () => {
  it("posts Claude-shaped body and converts SSE back to OpenAI", async () => {
    proxyFetchMock.mockResolvedValue(anthropicSSE());
    const ex = new OpenCodeExecutor();
    // client streams: converted events pass through plus the DONE terminator
    // (non-streaming clients are buffered into one JSON reply by chatCore).
    const { response } = await ex.execute({
      model: "union-alpha", body: { ...CHAT_BODY, stream: true }, stream: true,
      credentials: CREDS, signal: null, log: null, proxyOptions: null,
    });
    // upstream got Anthropic shape
    const sentBody = JSON.parse(proxyFetchMock.mock.calls[0][1].body);
    expect(Array.isArray(sentBody.messages)).toBe(true);
    expect(sentBody.messages[0].role).toBe("user");
    expect(sentBody._toolNameMap).toBeUndefined();
    // client gets OpenAI SSE with the text. The [DONE] terminator is appended
    // by the downstream stream controller, not the executor (same as github).
    const text = await response.text();
    expect(text).toContain("UNION_OK");
    expect(text).not.toContain("message_start");
  });

  it("passes upstream errors through untouched", async () => {
    proxyFetchMock.mockResolvedValue(
      new Response('{"error":"nope"}', { status: 500, headers: { "Content-Type": "application/json" } })
    );
    const ex = new OpenCodeExecutor();
    const { response } = await ex.execute({
      model: "union-alpha", body: CHAT_BODY, stream: false,
      credentials: CREDS, signal: null, log: null, proxyOptions: null,
    });
    expect(response.status).toBe(500);
  });
});
