/**
 * Opencode transparent-proxy fidelity (2026-09-19).
 *
 * The gateway fronts Zen for the user's own opencode clients (observability +
 * key control). Two fidelity gaps made the upstream call differ from what the
 * official client sends natively (captured via intercepting proxy):
 *
 * 1. A `developer` message was silently dropped by the generic OpenAI →
 *    Responses translator (it only knew system/user/assistant).
 * 2. The executor always stamped the gateway's own identity headers instead
 *    of forwarding the downstream client's own x-opencode headers and UA.
 *
 * Deliberately NOT covered: inventing prompt text. When the client sent no
 * system/developer content the body passes through untouched — the gateway
 * forwards identity, it never forges it.
 */
import { describe, expect, it } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import {
  OpenCodeExecutor,
  moveInstructionsToDeveloper,
  nativeHeader,
} from "../../open-sse/executors/opencode.js";

describe("translator preserves developer role", () => {
  it("keeps a developer message as a developer input item", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [
        { role: "developer", content: "You are a title generator." },
        { role: "user", content: "hi" },
      ],
    }, true, {});
    const dev = out.input.filter((i) => i.role === "developer");
    expect(dev).toHaveLength(1);
    expect(dev[0].content).toEqual([{ type: "input_text", text: "You are a title generator." }]);
  });

  it("still maps system to instructions (unchanged behavior)", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [
        { role: "system", content: "sys prompt" },
        { role: "user", content: "hi" },
      ],
    }, true, {});
    expect(out.instructions).toBe("sys prompt");
  });
});

describe("moveInstructionsToDeveloper", () => {
  it("prepends instructions as a developer input and clears the field", () => {
    const out = moveInstructionsToDeveloper({
      model: "m",
      instructions: "sys prompt",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(out.input.map((i) => i.role)).toEqual(["developer", "user"]);
    expect(out.input[0].content).toEqual([{ type: "input_text", text: "sys prompt" }]);
    expect(out.instructions).toBeUndefined();
  });

  it("passes through untouched when the client sent no prompt", () => {
    const body = { model: "m", input: [{ type: "message", role: "user", content: [] }] };
    expect(moveInstructionsToDeveloper(body)).toBe(body);
  });
});

describe("nativeHeader", () => {
  it("matches case-insensitively and trims", () => {
    expect(nativeHeader({ "X-OpenCode-Client": "  cli " }, "x-opencode-client")).toBe("cli");
  });

  it("returns null when absent", () => {
    expect(nativeHeader({}, "x-opencode-client")).toBeNull();
    expect(nativeHeader(null, "x-opencode-client")).toBeNull();
  });
});

describe("OpenCodeExecutor.buildHeaders passthrough", () => {
  const ex = new OpenCodeExecutor();

  it("forwards the downstream client's own identity headers", () => {
    const h = ex.buildHeaders({
      apiKey: "public",
      connectionId: "c",
      rawHeaders: {
        "x-opencode-client": "cli",
        "x-opencode-project": "proj-123",
        "x-opencode-request": "msg_abc",
        "x-opencode-session": "ses_abc",
        "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
      },
    });
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-project"]).toBe("proj-123");
    expect(h["x-opencode-request"]).toBe("msg_abc");
    expect(h["x-opencode-session"]).toBe("ses_abc");
    expect(h["user-agent"]).toContain("runtime/bun");
  });

  it("falls back to minted/defaults for non-opencode clients", () => {
    const h = ex.buildHeaders({ apiKey: "public", connectionId: "c" });
    expect(h["x-opencode-client"]).toBe("krouter");
    expect(h["x-opencode-project"]).toBe("global");
    expect(h["user-agent"]).toBe("opencode/1.18.31");
    expect(h["x-opencode-session"]).toMatch(/^ses_/);
  });
});
