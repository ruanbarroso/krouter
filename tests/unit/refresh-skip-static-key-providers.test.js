/**
 * A 403 from a static-key provider is a policy decision, not an expired token.
 *
 * BaseExecutor.refreshCredentials is a constant `null`, and 13 executors
 * inherit it unchanged (opencode, azure, iflow, ollama-local, …). Running the
 * retry loop against it can never mint a token: it sleeps 1s + 2s and then
 * logs "All 3 retry attempts failed" with no cause. Measured 2026-09-19 on
 * llm.barroso.tec.br: 148 OpenCode `FreeTierError` 403s drove 72 refresh
 * cycles, 0 successes, ~3s burned each before the combo fell to the next rung.
 */
import { describe, expect, it, vi } from "vitest";

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { refreshWithRetry } from "../../open-sse/services/tokenRefresh.js";

const cfg = { baseUrl: "https://example.invalid", models: [] };

describe("canRefreshCredentials", () => {
  it("is false for an executor that never overrode refreshCredentials", () => {
    expect(new OpenCodeExecutor("opencode", cfg).canRefreshCredentials()).toBe(false);
    expect(new BaseExecutor("base", cfg).canRefreshCredentials()).toBe(false);
  });

  it("is true as soon as a subclass implements a refresh flow", () => {
    class Refreshing extends BaseExecutor {
      async refreshCredentials() {
        return { accessToken: "t" };
      }
    }
    expect(new Refreshing("refreshing", cfg).canRefreshCredentials()).toBe(true);
  });

  it("short-circuits the handler condition on a 403, so no refresh runs", async () => {
    const executor = new OpenCodeExecutor("opencode", cfg);
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let refreshRan = false;

    // The exact condition the 401/403 handlers evaluate.
    if (!executor.noAuth && executor.canRefreshCredentials()) {
      refreshRan = true;
      await refreshWithRetry(() => executor.refreshCredentials({}, log), 3, log);
    }

    expect(refreshRan).toBe(false);
    // No sleeping, and no causeless "All 3 retry attempts failed" in the journal.
    expect(log.error).not.toHaveBeenCalled();
  });

  it("is defeated by an instance-level patch — do not spy on refreshCredentials", () => {
    const executor = new OpenCodeExecutor("opencode", cfg);
    expect(executor.canRefreshCredentials()).toBe(false);
    // vi.spyOn installs an OWN property, which breaks the prototype identity
    // check and flips the guard to true. Pinned so the trap is discovered here
    // rather than in a test that silently stops testing anything.
    vi.spyOn(executor, "refreshCredentials");
    expect(executor.canRefreshCredentials()).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("refreshWithRetry logs a cause for every failed attempt", () => {
  it("reports a falsy return instead of failing silently", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await refreshWithRetry(async () => null, 3, log);

    expect(result).toBeNull();
    // Previously this path logged nothing per attempt: only the throw branch
    // had a message, so a clean failure left just the final line with no reason.
    const attemptLines = log.warn.mock.calls.filter(([tag]) => tag === "TOKEN_REFRESH");
    expect(attemptLines).toHaveLength(3);
    expect(attemptLines[0][1]).toMatch(/returned no credentials/);
    expect(log.error).toHaveBeenCalledWith("TOKEN_REFRESH", "All 3 retry attempts failed");
  });

  it("still reports a thrown cause", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await refreshWithRetry(async () => { throw new Error("boom"); }, 2, log);

    expect(log.warn).toHaveBeenCalledWith("TOKEN_REFRESH", "Attempt 1/2 failed: boom");
  });
});
