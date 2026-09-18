import { describe, it, expect } from "vitest";
import { getLiveFetcher } from "@/shared/constants/liveFetch.js";
import {
  OAUTH_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  APIKEY_PROVIDERS,
} from "@/shared/constants/providers.js";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";

// The 8 providers on /dashboard/providers must all resolve their model list
// from a provider API at runtime — never from a hardcoded list alone.
// This test pins the wiring (not the model ids): every dashboard id needs a
// live path — LIVE_FETCH (connection key), modelsFetcher (public catalog),
// or a connection-based resolver in the per-provider models route.
describe("provider live-catalog wiring (dashboard providers)", () => {
  const DASHBOARD_IDS = [
    "claude",
    "codex",
    "kiro",
    "mimo-free",
    "openrouter",
    "nvidia",
    "gemini",
    "opencode",
  ];

  it("all 8 dashboard provider ids exist in the provider constants", () => {
    const all = {
      ...OAUTH_PROVIDERS,
      ...FREE_PROVIDERS,
      ...FREE_TIER_PROVIDERS,
      ...APIKEY_PROVIDERS,
    };
    for (const id of DASHBOARD_IDS) {
      expect(all[id], `${id} must be a known provider`).toBeDefined();
    }
  });

  it("key-based providers have a LIVE_FETCH entry (connection key → provider /models)", () => {
    // openrouter, nvidia, gemini serve OpenAI/REST-shaped /models; opencode
    // shares the zen catalog. claude authenticates as x-api-key or Bearer
    // (dual-auth in both live routes).
    for (const id of ["openrouter", "nvidia", "gemini", "opencode", "claude"]) {
      expect(getLiveFetcher(id), `${id} needs a LIVE_FETCH entry`).not.toBeNull();
    }
  });

  it("public-catalog providers expose a modelsFetcher with a known filter", () => {
    // No connection needed: the dashboard Suggested section fetches these
    // directly from the provider's public API.
    const all = {
      ...FREE_PROVIDERS,
      ...FREE_TIER_PROVIDERS,
      ...APIKEY_PROVIDERS,
    };
    for (const id of ["mimo-free", "openrouter", "nvidia", "opencode"]) {
      const fetcher = all[id]?.modelsFetcher;
      expect(fetcher?.url, `${id} needs modelsFetcher.url`).toMatch(/^https?:\/\//);
      expect(FILTERS[fetcher.type], `${id} fetcher type ${fetcher?.type} needs a FILTER`).toBeDefined();
    }
  });

  it("OAuth providers resolve via connection (documented, no public catalog)", () => {
    // claude, codex, kiro and gemini-API-key have no public models endpoint;
    // their live catalog arrives after the user connects (per-provider models
    // route: PROVIDER_MODELS_CONFIG with OAuth resolvers). Pin that they are
    // NOT mistakenly wired to a public fetcher, which would leak or 401.
    const all = {
      ...OAUTH_PROVIDERS,
      ...FREE_PROVIDERS,
      ...FREE_TIER_PROVIDERS,
    };
    for (const id of ["claude", "codex", "kiro"]) {
      expect(all[id]?.modelsFetcher, `${id} must not have a public modelsFetcher`).toBeUndefined();
    }
  });
});
