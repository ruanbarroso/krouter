import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// ─── Upstream lendo devagar vs proxy quebrado ───────────────────────────────
// O timer de headers dos executores (base.js, qoder.js) aborta o fetch quando
// o UPSTREAM não devolve headers a tempo — o proxy pode ter conectado bem.
// Sem a distinção, um upstream lento sob strictProxy sai no log como "Proxy
// required but failed" e toda investigação vai para a camada errada (medido
// 2026-09-18: relays íntegros com credencial válida, NVIDIA lenta; 100% das
// tentativas rotuladas como falha de proxy).
//
// O marcador viaja no `code` do motivo do abort (o fetch rejeita com ele), e
// a mensagem legada continua valendo como segunda via para quem aborta com
// `Error` puro. Desconexão do cliente não casa: ela aborta com AbortError
// (DOMException), sem este código nem esta mensagem.
export const UPSTREAM_HEADERS_TIMEOUT_CODE = "UPSTREAM_HEADERS_TIMEOUT";
export function newUpstreamHeadersTimeoutError() {
  const err = new Error("fetch connect timeout");
  err.code = UPSTREAM_HEADERS_TIMEOUT_CODE;
  return err;
}
export function isUpstreamHeadersTimeout(err) {
  return err?.code === UPSTREAM_HEADERS_TIMEOUT_CODE
    || /fetch connect timeout/i.test(String(err?.message || ""));
}

// ─── HTTPS Keep-Alive Agents (added 0.5.15) ─────────────────────────────────
// Reuses TCP+TLS connections across requests to the same upstream so every
// LLM call doesn't pay the ~150-300ms TLS handshake cost. Two surfaces use
// these:
//   1. The native-fetch path (no proxy, no MITM-bypass) gets a singleton
//      undici.Agent injected as dispatcher.
//   2. The createBypassRequest path (manual IP-resolved socket connect) gets
//      a per-host https.Agent so subsequent requests to api.anthropic.com /
//      cloudcode-pa / etc. reuse the TLS session.
// Both pools are bounded; idle sockets close after 60s to avoid holding
// connections forever in an idle dev process.
let _keepAliveDispatcher = null;
async function getKeepAliveDispatcher() {
  if (_keepAliveDispatcher) return _keepAliveDispatcher;
  try {
    const { Agent } = await import("undici");
    _keepAliveDispatcher = new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      connections: 50, // max sockets per host:port
      pipelining: 1,
    });
  } catch {
    _keepAliveDispatcher = null;
  }
  return _keepAliveDispatcher;
}

const _bypassHttpsAgents = new Map();
async function getBypassHttpsAgent(realIP, servername) {
  const key = `${servername}|${realIP}`;
  const existing = _bypassHttpsAgents.get(key);
  if (existing) return existing;
  const httpsModule = await import("https");
  const https = httpsModule.default ?? httpsModule;
  // Custom createConnection overrides DNS — every reused socket from this
  // agent dials realIP directly while presenting the correct SNI / Host so
  // upstream TLS validation passes against the public CA chain.
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60_000,
    scheduling: "lifo",
  });
  _bypassHttpsAgents.set(key, agent);
  return agent;
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
// Hosts where kRouter's own outbound calls must bypass the MITM /etc/hosts spoof.
// When MITM intercept is enabled for a tool, /etc/hosts redirects the upstream
// hostname → 127.0.0.1 so the IDE traffic lands on our MITM server. But our
// OWN server-side calls (Claude OAuth, autoping, quota usage, provider model
// list fetch, etc.) must reach the REAL upstream — otherwise we'd intercept
// ourselves and hit a self-signed-cert error. The header guard works for the
// MITM dispatcher, but the OS-level DNS spoof needs this bypass list to know
// "always resolve via Google DNS for these hosts, never use /etc/hosts".
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
  // Added 0.5.15: api.anthropic.com was added to TARGET_HOSTS in 0.5.12 when
  // we shipped the Claude Desktop MITM handler, but never to the bypass list.
  // Result: every kRouter → Anthropic call (autoping, getClaudeUsage, OAuth
  // refresh) was doing a manual Google-DNS resolve on every cache miss.
  "api.anthropic.com",
];
// Resolver used to sidestep the /etc/hosts MITM spoof. Public DNS by default;
// KROUTER_DNS_SERVERS overrides it for hosts whose egress firewall only allows
// the local stub — a fail-closed deployment REJECTs 8.8.8.8:53 outright, and
// every bypass resolve then dies with ECONNREFUSED (measured 2026-09-18).
const DEFAULT_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];

function configuredDnsServers() {
  const raw = normalizeString(process.env.KROUTER_DNS_SERVERS);
  if (!raw) return DEFAULT_DNS_SERVERS;
  const servers = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return servers.length ? servers : DEFAULT_DNS_SERVERS;
}
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  let dns;
  let promisify;
  try {
    dns = await import("dns");
    ({ promisify } = await import("util"));
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }

  const attempts = [
    // 1. Explicit servers — immune to /etc/hosts, which is the point of the bypass.
    async () => {
      const resolver = new dns.Resolver();
      resolver.setServers(configuredDnsServers());
      return promisify(resolver.resolve4.bind(resolver))(hostname);
    },
    // 2. System resolver — last resort when egress to public DNS is firewalled.
    //    dns.resolve4() queries the configured nameservers and does not read
    //    /etc/hosts itself, but a stub resolver (systemd-resolved) DOES
    //    synthesize those entries, so a loopback answer is the MITM spoof
    //    leaking back in. Refuse it and keep the bypass honest.
    async () => promisify(dns.resolve4)(hostname),
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const addresses = await attempt();
      const ip = addresses?.[0];
      if (!ip) continue;
      if (isLoopbackAddress(ip)) {
        lastError = new Error(`refusing loopback answer ${ip} for ${hostname} (MITM spoof)`);
        continue;
      }
      DNS_CACHE.set(hostname, { ip, expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
      return ip;
    } catch (error) {
      lastError = error;
    }
  }

  console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, lastError?.message);
  return null;
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

// ─── Fail-closed egress policy ──────────────────────────────────────────────
// strictProxy is a PER-POOL flag (see connectionProxy.js), so it only reaches
// proxyAwareFetch when a pool actually resolved. A connection with NO pool
// assigned lands on `source: "none"`, which carries no strictProxy at all —
// it egressed direct, from the host's own IP, which is precisely what the
// relay pool exists to prevent. Measured 2026-09-18 on llm.barroso.tec.br:
// 845 kiro routings, 146 with a pool; the rest went direct, died at the host
// firewall, and surfaced to the client as a bare "fetch failed".
//
// KROUTER_REQUIRE_PROXY=1 makes the application agree with a fail-closed host
// firewall: no proxy resolved + public destination = refuse, naming the host
// instead of leaking a generic network error. Off by default, so deployments
// without such a firewall keep the permissive behaviour.
function requireProxyForEgress() {
  const raw = normalizeString(process.env.KROUTER_REQUIRE_PROXY).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function stripBrackets(host) {
  return normalizeString(host).replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isLoopbackAddress(host) {
  const h = stripBrackets(host);
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

// Destinations that never cross the public internet, so they are not "egress"
// and must stay reachable without a proxy: loopback sidecars, the dashboard's
// own calls, tailnet peers, and the relays themselves (100.64.0.0/10).
const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".localdomain", ".ts.net"];

function isPrivateEgressTarget(hostname) {
  const h = stripBrackets(hostname);
  if (!h) return false;
  if (isLoopbackAddress(h)) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  // A bare label (no dot) is a container/service name, never a public host.
  if (!h.includes(".") && !h.includes(":")) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
    if (a === 169 && b === 254) return true;           // link-local / cloud metadata
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd]/.test(h) || h.startsWith("fe80:")) return true;
  return false;
}

// Called immediately before every path that would leave this process without a
// proxy. Throws with an actionable message instead of letting the request die
// as an anonymous network error three layers up.
function assertDirectEgressAllowed(targetUrl, proxyOptions) {
  const strict = proxyOptions?.strictProxy === true;
  if (!strict && !requireProxyForEgress()) return;

  let hostname;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return; // Unparseable target: leave it to the fetch layer to reject.
  }
  if (isPrivateEgressTarget(hostname)) return;

  const cause = strict
    ? "the resolved proxy pool is strictProxy=true but no proxy URL survived resolution"
    : "no proxy pool is assigned to this connection and KROUTER_REQUIRE_PROXY is on";
  throw new Error(
    `[ProxyFetch] Direct egress to ${hostname} refused: ${cause}. ` +
    `Assign a proxy pool to this connection (dashboard → Connections), ` +
    `or clear KROUTER_REQUIRE_PROXY to permit direct egress.`
  );
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 *
 * 0.5.15: Now backed by a keep-alive https.Agent that pools sockets per
 * host:realIP. First request pays ~200ms TLS; subsequent requests reuse
 * the open socket and complete in 1-2 RTTs without a new handshake.
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const https = httpsModule.default ?? httpsModule;
  const agent = await getBypassHttpsAgent(realIP, parsedUrl.hostname);

  return new Promise((resolve, reject) => {
    const reqOptions = {
      host: realIP,
      port: HTTPS_PORT,
      // SNI + cert hostname are validated against the hostname the caller
      // asked for, not the IP we connected to. This keeps the DNS-bypass
      // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
      // that present a different cert. The MITM_BYPASS_HOSTS targets are
      // all public-CA-issued (Google / GitHub / AWS / Cursor / Anthropic)
      // so default verification works without any extra trust store.
      servername: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "POST",
      headers: {
        ...options.headers,
        Host: parsedUrl.hostname,
        // Hint to upstream that we want to reuse this connection.
        Connection: "keep-alive",
      },
      agent,
    };

    const req = https.request(reqOptions, (res) => {
      const response = {
        ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: new Map(Object.entries(res.headers)),
        body: Readable.toWeb(res),
        text: async () => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          return Buffer.concat(chunks).toString();
        },
        json: async () => JSON.parse(await response.text()),
      };
      resolve(response);
    });

    req.on("error", reject);
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // Egress point 1 of 3: nothing resolved, so both the MITM manual-resolve
  // below and the native fetch at the bottom would go direct. Refuse here so
  // the bypass never even attempts a DNS lookup it has no use for.
  if (!proxyUrl) assertDirectEgressAllowed(targetUrl, proxyOptions);

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch(url, { ...options, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          if (isUpstreamHeadersTimeout(proxyError)) {
            throw new Error(`[ProxyFetch] Upstream timed out waiting for response headers (strictProxy=true: failing closed without direct attempt): ${proxyError.message}`);
          }
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        // Egress point 2 of 3: the proxy existed and failed, and strictProxy is
        // off — the manual-resolve bypass below would leave direct.
        assertDirectEgressAllowed(targetUrl, proxyOptions);
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await originalFetch(url, { ...options, dispatcher });
    } catch (proxyError) {
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        if (isUpstreamHeadersTimeout(proxyError)) {
          throw new Error(`[ProxyFetch] Upstream timed out waiting for response headers (strictProxy=true: failing closed without direct attempt): ${proxyError.message}`);
        }
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      // Egress point 3 of 3: non-strict fallback to a direct connection.
      assertDirectEgressAllowed(targetUrl, proxyOptions);
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return originalFetch(url, options);
    }
  }

  // got-scraping disabled — use native fetch with a keep-alive dispatcher so
  // repeat calls to the same upstream (api.openai.com, oauth2.googleapis.com,
  // openrouter.ai, etc.) reuse the TLS session and shave ~150-300ms per call.
  const dispatcher = await getKeepAliveDispatcher();
  if (dispatcher) {
    return originalFetch(url, { ...options, dispatcher });
  }
  return originalFetch(url, options);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
