// Regression test: the Gemini provider rejects requests whose JSON body
// carries OpenAI's `stream` field. chatCore keeps streaming selection in the
// endpoint suffix (:streamGenerateContent), so strip it after translation.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function geminiBody(model = "gemini-3.8-flash") {
  return {
    model,
    stream: true,
    max_tokens: 16,
    messages: [{ role: "user", content: "say hi" }],
  };
}

describe("bug: Gemini rejects bodies with a stream field", () => {
  it("OpenAI→Gemini drops stream but keeps the converted request", async () => {
    // chatCore line below mirrors "if (provider === "gemini") delete translatedBody.stream"
    const source = readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");
    expect(source).toContain('provider === "gemini"');
    expect(source).toContain("delete translatedBody.stream");

    for (const stream of [true, false]) {
      const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-3.8-flash", geminiBody(), stream);
      expect(out.stream, `stream=${stream} leaked into Gemini body`).toBeUndefined();
      expect(out.contents?.[0]?.parts?.[0]?.text).toBe("say hi");
      expect(out.generationConfig?.maxOutputTokens).toBe(16);
    }
  });
});
