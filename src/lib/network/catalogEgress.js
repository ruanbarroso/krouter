import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

// Catalog egress — model-catalog fetches must follow the same egress path the
// serving stack uses, or they die on hosts with fail-closed outbound firewalls
// (llm.barroso.tec.br: the `krouter` user only reaches loopback and the proxy
// relays; every direct fetch returns "fetch failed" and the dashboard silently
// falls back to the static list).
//
// Precedence mirrors the serving path (see src/sse/services/auth.js):
//   1. Per-connection proxy config (providerSpecificData — the pool or legacy
//      proxy set in the connection's Edit modal), same as inference traffic.
//   2. Provider-level pool the dashboard proxy cards write to
//      `providerStrategies.<provider>.proxyPoolId` — the same source the OAuth
//      connect flow reads (resolveOAuthEgress in lib/oauth/providers.js).
//   3. Direct (no proxy configured) — the pre-existing behavior, which keeps
//      working on hosts without an egress firewall.
//
// Resolution never throws: a proxy lookup must not break a catalog that
// would otherwise work. When both lookups miss, callers get null and fetch
// directly, exactly as before this module existed.

/**
 * Resolve the egress proxy options for a catalog fetch.
 * @param {string} provider dashboard provider id (e.g. "claude", "nvidia")
 * @param {object|null} providerSpecificData connection's providerSpecificData, when fetching with a connection
 * @returns {Promise<object|null>} resolveConnectionProxyConfig() shape, or null for direct
 */
export async function resolveCatalogEgress(provider, providerSpecificData = null) {
  // 1. Per-connection config, same as the serving path.
  if (
    providerSpecificData &&
    (providerSpecificData.proxyPoolId ||
      providerSpecificData.connectionProxyEnabled ||
      providerSpecificData.vercelRelayUrl)
  ) {
    try {
      const resolved = await resolveConnectionProxyConfig(providerSpecificData);
      if (resolved && (resolved.connectionProxyUrl || resolved.vercelRelayUrl)) {
        return resolved;
      }
    } catch { /* fall through to provider-level */ }
  }

  // 2. Provider-level pool (providerStrategies.<provider>.proxyPoolId).
  // Dynamic import keeps the web-route bundle free of a static edge back into
  // the OAuth module (same pattern as oauthFetch in lib/oauth/providers.js).
  try {
    if (provider) {
      const { resolveOAuthProxyOptions } = await import("@/lib/oauth/providers.js");
      const resolved = await resolveOAuthProxyOptions(provider);
      if (resolved) return resolved;
    }
  } catch { /* direct */ }

  return null;
}

/**
 * Fetch a model catalog, honoring the provider's egress options when present.
 * proxyOptions is the resolveConnectionProxyConfig() shape from
 * resolveCatalogEgress(); null means direct fetch, as before.
 */
export async function catalogFetch(url, options = {}, proxyOptions = null) {
  if (!proxyOptions) return fetch(url, options);
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  return proxyAwareFetch(url, options, proxyOptions);
}
