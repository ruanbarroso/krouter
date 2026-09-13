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
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${seed}`)
    .digest("hex")
    .slice(0, 32);
  return `ses_${digest}`;
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
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "x-opencode-client": "desktop",
      "x-request-source": "local",
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
