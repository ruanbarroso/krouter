import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { deriveSessionId } from "../utils/sessionManager.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { translateRequest, translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Models that use /zen/v1/messages (Anthropic Messages shape).
// union-alpha is a stealth agentic-coding model the opencode frontend serves
// exclusively over /zen/v1/messages with the Anthropic SDK — posting it to
// /chat/completions 500s on every account (measured 2026-09-18).
const MESSAGES_MODELS = new Set(["union-alpha"]);

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

// CORREÇÃO 2026-09-19 — o bloco anterior aqui afirmava, como medido, que o
// free tier do Console valida os HEADERS (id de sessão no formato certo +
// User-Agent `opencode/<versão>`). Isso está ERRADO e foi retratado: aquele
// experimento de 09-17 variou headers e corpo ao mesmo tempo e creditou ao
// header a diferença que era do corpo.
//
// Medido 2026-09-19 com um proxy interceptando o cliente oficial e replay
// controlado (uma variável por vez, resto byte a byte idêntico):
//   corpo real + headers do opencode ........... 200
//   corpo real + headers do KROUTER ............ 200   <- headers não importam
//   corpo mínimo + headers do opencode ......... 403
//   prompt `developer` real + user "hi" ........ 200
//   prompt `developer` genérico ................ 403
// Ou seja: o discriminante é o CONTEÚDO DO PROMPT DE SISTEMA, não o header.
// Nenhum ajuste de header, id, UA, proxy ou IP faz o free tier passar por
// aqui — é um controle do provedor restringindo o tier ao cliente dele, e o
// caminho legítimo é `opencode auth login` (100 req/dia) colado nas conexões
// do dashboard. Ver OKF findings/opencode-zen-valida-prompt-de-sistema-2026-09-19.
//
// O que segue vale por fidelidade de formato, não por efeito no 403:
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

// 48 bits, como packages/opencode/src/id/id.ts. `Date.now() * 0x1000` passa de
// 2^48, e o truncamento é do formato, NÃO um bug: um id real capturado do
// cliente oficial (msg_0b9c56b7f001...) decodifica para 1971 exatamente assim.
const OPENCODE_ID_MASK = 0xffffffffffffn;
// Desempata ids emitidos no mesmo milissegundo, como o counter do upstream.
let openCodeIdCounter = 0;

// Mint an opencode-format id: `<prefix>_<12 hex><14 base62>`, onde os 12 hex
// são `(Date.now() * 0x1000 + counter) & 2^48-1` — ascendente para mensagens,
// COMPLEMENTADO (`~n`) para sessões, que o upstream emite em ordem decrescente
// para que a listagem mais recente venha primeiro. O sufixo vem do seed para
// que a mesma conversa mantenha afinidade em vez de parecer um cliente novo a
// cada turno.
//
// Verificado 2026-09-19 contra uma captura do cliente oficial: com
// ses_f463a94adffe... e msg_0b9c56b7f001... emitidos na mesma sessão,
// `~msg & MASK` = f463a9480ffe reproduz o `ses` até o 7º dígito — a diferença
// restante são os 45 ms entre a criação da sessão e a da mensagem.
export function mintOpenCodeId(prefix, seed, { descending = false } = {}) {
  const n = BigInt(Date.now()) * 0x1000n + BigInt(openCodeIdCounter++ & 0xfff);
  const value = descending ? (~n & OPENCODE_ID_MASK) : (n & OPENCODE_ID_MASK);
  const timeHex = value.toString(16).padStart(12, "0");
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

// Read one incoming client header case-insensitively, trimmed and capped so a
// caller-supplied value can never become a header-injection vector. Returns
// null when the client did not send it — the caller then falls back to the
// minted/default value.
export function nativeHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 256);
    }
  }
  return null;
}

// The Zen Responses endpoint serves the caller's system prompt as a
// `developer` input message (captured 2026-09-19 from the official client:
// input roles `developer,user,user`, no `instructions` field). The generic
// OpenAI→Responses translator lands a `system` message on `instructions`, so
// map it back to the native shape here: prepend as developer input, preserving
// message order (system first). Never invents prompt text — when the client
// sent no system/developer content the body passes through untouched.
export function moveInstructionsToDeveloper(transformedBody) {
  const instructions = transformedBody?.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) return transformedBody;
  return {
    ...transformedBody,
    instructions: undefined,
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] },
      ...(Array.isArray(transformedBody.input) ? transformedBody.input : []),
    ],
  };
}

function translatedSession(seed, clientTool) {
  void clientTool;
  // Sessão é DESCENDENTE no upstream (Identifier.descending("ses")).
  return mintOpenCodeId("ses", `session\0${seed}`, { descending: true });
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
    if (MESSAGES_MODELS.has(args.model)) {
      return this.executeWithMessagesEndpoint({ ...args, credentials });
    }
    return super.execute({ ...args, credentials });
  }

  // union-alpha and friends arrive OpenAI-shaped but only serve the Anthropic
  // Messages endpoint — same shim as the github executor's /v1/messages path:
  // translate OpenAI→Claude, force stream upstream (chatCore buffers SSE into
  // a single JSON reply for non-streaming clients), translate events back.
  async executeWithMessagesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model);
    const headers = this.buildHeaders(credentials, true);
    const translatedBody = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, body, true, credentials, "opencode");
    // _toolNameMap is internal bookkeeping; strip it before dispatch.
    const toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;

    log?.debug?.("OPENCODE", `Sending translated request to /zen/v1/messages for ${model}`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(translatedBody),
      signal,
    }, proxyOptions);

    if (!response.ok) {
      return { response, url, headers, transformedBody: translatedBody };
    }

    const state = initState(FORMATS.CLAUDE);
    state.model = model;
    if (toolNameMap) state.toolNameMap = toolNameMap;

    const decoder = new TextDecoder();
    let buffer = "";

    const emitAll = (controller, chunks) => {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(formatSSE(c, "openai")));
      }
    };

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
          emitAll(controller, translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, parsed, state));
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            emitAll(controller, translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, parsed, state));
          }
        }
      },
    });

    if (!response.body) {
      return { response: new Response("", { status: response.status, headers: response.headers }), url, headers, transformedBody: translatedBody };
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
      transformedBody: translatedBody,
    };
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken || "public";
    const seed = resolveOpenCodeSeed(credentials || {}, null);
    // Transparent proxy: when the downstream client is the official client it
    // already sends its own identity headers — forward them verbatim instead
    // of stamping the gateway's own. Falls back to minted/defaults for
    // non-opencode clients. (credentials.rawHeaders is threaded from the
    // incoming request by chatCore; absent in tests and non-chat paths.)
    const incoming = credentials?.rawHeaders || null;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "x-opencode-client": nativeHeader(incoming, "x-opencode-client") || OPENCODE_CLIENT_NAME,
      "x-request-source": "local",
      "x-opencode-request": nativeHeader(incoming, "x-opencode-request")
        || translatedRequestId(`${seed}\0${Date.now()}`),
      "x-opencode-project": nativeHeader(incoming, "x-opencode-project") || "global",
      "user-agent": nativeHeader(incoming, "user-agent") || OPENCODE_USER_AGENT,
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
    const transformedBody = moveInstructionsToDeveloper(
      openaiToOpenAIResponsesRequest(model, chatBody, true, credentials)
    );

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
