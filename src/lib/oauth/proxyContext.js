import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the egress proxy for one OAuth connect flow (authorize → exchange /
 * device-code → poll) across the provider-method call chain without threading
 * a parameter through every provider implementation.
 *
 * The dashboard route resolves the provider's proxy pool
 * (see resolveOAuthProxyOptions in providers.js) and runs the exported OAuth
 * helpers inside runWithOAuthProxy(). oauthFetch() then routes those
 * server-side calls through proxyAwareFetch. Concurrent connects for
 * different providers stay isolated: AsyncLocalStorage is scoped to each
 * async chain, and a null store means "direct, as before".
 */
export const oauthProxyStorage = new AsyncLocalStorage();

export function getOAuthProxyOptions() {
  try {
    return oauthProxyStorage.getStore() ?? null;
  } catch {
    return null;
  }
}

export function runWithOAuthProxy(proxyOptions, fn) {
  return oauthProxyStorage.run(proxyOptions ?? null, fn);
}
