import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { deriveSessionId } from "../utils/sessionManager.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState } from "../translator/index.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// Models that only serve /zen/v1/responses (OpenAI Responses API).
// Measured 2026-09-09: muse-spark-* 200 on /responses, deterministic 500 on
// /chat/completions (14/14). Matched by prefix so live-catalog variants
// (e.g. future -free suffixes) route correctly; everything else stays on
// /chat/completions (nemotron, ling, big-pickle, mimo only serve chat).
export function isOpenCodeResponsesModel(model) {
  return typeof model === "string" && model.toLowerCase().startsWith("muse-spark");
}

// OpenCode zen rejects a request that arrives without this header:
//   400 MissingSessionID -- "Request is missing x-opencode-session and cannot be
//   routed efficiently."
// Stable for the life of a conversation; carried on the per-request credentials
// copy rather than on the singleton executor.
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
const MAX_SESSION_LENGTH = 256;

// The Console free tier validates the caller looks like a real client
// (measured 2026-09-17, production outage: every variant with a forged
// session id or a non-opencode User-Agent 403s with
// "FreeTierError: OpenCode's free tier can only be used from within OpenCode",
// while fresh opencode-format ids + official UA 200):
//   1. session/request ids follow packages/opencode/src/id/id.ts:
//      `<prefix>_<12 hex: timestamp_ms * 0x1000>_<14 base62 random>`.
//      Fabricated ids (stale timestamp or wrong shape) are rejected.
//   2. User-Agent must be `opencode/<version>` — bump alongside official
//      releases; a stale version will eventually read as foreign again.
// The x-opencode-client value itself is free-form (measured: any non-empty
// value passes, so this gateway identifies honestly as `krouter`).
const OPENCODE_USER_AGENT = "opencode/1.18.31";
const OPENCODE_CLIENT_NAME = "krouter";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62FromDigest(digest, length) {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    const byte = digest[i % digest.length];
    out += BASE62[(byte + i) % 62];
  }
  return out;
}

// Mint an opencode-format id: fresh timestamp (the Console rejects stale or
// malformed ones) + suffix derived deterministically from the seed so the
// same conversation keeps affinity instead of looking like a new client
// every turn.
export function mintOpenCodeId(prefix, seed) {
  // BigInt: Date.now() * 0x1000 overflows float->int32 bitwise ops (they wrap
  // to a NEGATIVE number and toString(16) emits "-...").
  const timeHex = ((BigInt(Date.now()) * 0x1000n) & 0xffffffffffffn).toString(16).padStart(12, "0");
  const suffix = base62FromDigest(
    crypto.createHash("sha256").update(`opencode\0${seed}`).digest(),
    14
  );
  return `${prefix}_${timeHex}${suffix}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === OPENCODE_SESSION_HEADER) return normalizeSession(value);
  }
  return null;
}

function translatedSession(seed, clientTool) {
  void clientTool;
  return mintOpenCodeId("ses", `session\0${seed}`);
}

function translatedRequestId(seed) {
  return mintOpenCodeId("msg", `request\0${seed}`);
}

export function resolveOpenCodeSeed(credentials, body) {
  const explicit =
    body?.prompt_cache_key
    || body?.session_id
    || body?.conversation_id
    || body?.metadata?.session_id
    || body?.metadata?.conversation_id;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const workspaceId = credentials?.providerSpecificData?.workspaceId;
  if (typeof workspaceId === "string" && workspaceId.trim()) return workspaceId.trim();

  return deriveSessionId(credentials?.connectionId || credentials?.id);
}

export function openCodeSessionId({ credentials, body, clientTool } = {}) {
  const native = nativeSession(credentials?.rawHeaders);
  return native || translatedSession(resolveOpenCodeSeed(credentials || {}, body), clientTool);
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body) {
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = "https://opencode.ai";
    if (MESSAGES_MODELS.has(model)) return `${base}/zen/v1/messages`;
    if (isOpenCodeResponsesModel(model)) return `${base}/zen/v1/responses`;
    return `${base}/zen/v1/chat/completions`;
  }

  prepareRequestCredentials({ body, credentials, clientTool } = {}) {
    const source = credentials || {};
    return {
      ...source,
      [SESSION_FIELD]: openCodeSessionId({ credentials: source, body, clientTool }),
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    if (isOpenCodeResponsesModel(args.model)) {
      return this.executeWithResponsesEndpoint({ ...args, credentials });
    }
    return super.execute({ ...args, credentials });
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken || "public";
    const seed = resolveOpenCodeSeed(credentials || {}, null);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "x-opencode-client": OPENCODE_CLIENT_NAME,
      "x-request-source": "local",
      "x-opencode-request": translatedRequestId(`${seed}\0${Date.now()}`),
      "x-opencode-project": "global",
      "user-agent": OPENCODE_USER_AGENT,
    };
    if (stream) headers["Accept"] = "text/event-stream";
    headers[OPENCODE_SESSION_HEADER] = credentials?.[SESSION_FIELD]
      || openCodeSessionId({ credentials });
    return headers;
  }

  async executeWithResponsesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model);
    const headers = this.buildHeaders(credentials, true);
    const chatBody = this.transformRequest(model, body);
    const transformedBody = openaiToOpenAIResponsesRequest(model, chatBody, true, credentials);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    }, proxyOptions);

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    const state = initState("openai-responses");
    state.model = model;
    const decoder = new TextDecoder();
    let buffer = "";

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parsed = parseSSELine(trimmed);
          if (!parsed) continue;
          if (parsed.done && stream === true) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            continue;
          }
          const converted = openaiResponsesToOpenAIResponse(parsed, state);
          if (converted) {
            controller.enqueue(new TextEncoder().encode(formatSSE(converted, "openai")));
          }
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const converted = openaiResponsesToOpenAIResponse(parsed, state);
            if (converted) {
              controller.enqueue(new TextEncoder().encode(formatSSE(converted, "openai")));
            }
          }
        }
        const tail = openaiResponsesToOpenAIResponse(null, state);
        if (tail) {
          controller.enqueue(new TextEncoder().encode(formatSSE(tail, "openai")));
        }
      },
    });

    if (!response.body) {
      return { response: new Response("", { status: response.status, headers: response.headers }), url, headers, transformedBody };
    }
    const convertedStream = response.body.pipeThrough(transformStream);

    return {
      response: new Response(convertedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      url,
      headers,
      transformedBody,
    };
  }
}
