/**
 * `response_format` was reaching the gateway and dying in translation.
 *
 * Measured on llm.barroso.tec.br 2026-09-18: a client sent
 * `response_format: {type:"json_schema", strict:true, ...}` and the Gemini
 * adapter sent `generationConfig: {}` upstream. Same for `json_object`. The
 * model answered free-form prose with HTTP 200, which downstream reads as "the
 * model ignored the schema" — it never saw one. The Codex/Responses path
 * dropped it the same way, since that API spells the field `text.format`.
 *
 * Default is passthrough. Translation only where the provider spells the same
 * contract differently, and one documented drop where forwarding it would 400.
 */
import { describe, expect, it } from "vitest";
import { openaiToGeminiRequest, openaiToGeminiCLIRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const MESSAGES = [{ role: "user", content: "extract the total" }];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { total: { type: "integer" } },
  required: ["total"]
};

const jsonSchemaFormat = (extra = {}) => ({
  type: "json_schema",
  json_schema: { name: "t", strict: true, schema: structuredClone(SCHEMA), ...extra }
});

describe("Gemini: response_format -> generationConfig", () => {
  it("maps json_schema to responseMimeType + responseSchema", () => {
    const out = openaiToGeminiRequest("gemini-3.7-flash", {
      messages: MESSAGES,
      response_format: jsonSchemaFormat()
    }, false);

    expect(out.generationConfig.responseMimeType).toBe("application/json");
    expect(out.generationConfig.responseSchema).toMatchObject({
      type: "object",
      properties: { total: { type: "integer" } },
      required: ["total"]
    });
  });

  it("sanitises the schema the same way tool parameters are sanitised", () => {
    const out = openaiToGeminiRequest("gemini-3.7-flash", {
      messages: MESSAGES,
      response_format: jsonSchemaFormat()
    }, false);

    // Gemini 400s on additionalProperties; the caller is allowed to send it.
    expect(out.generationConfig.responseSchema.additionalProperties).toBeUndefined();
  });

  it("does not mutate the caller's schema object", () => {
    const body = { messages: MESSAGES, response_format: jsonSchemaFormat() };
    openaiToGeminiRequest("gemini-3.7-flash", body, false);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it("maps json_object to responseMimeType with no schema", () => {
    const out = openaiToGeminiRequest("gemini-3.7-flash", {
      messages: MESSAGES,
      response_format: { type: "json_object" }
    }, false);

    expect(out.generationConfig.responseMimeType).toBe("application/json");
    expect(out.generationConfig.responseSchema).toBeUndefined();
  });

  it("keeps the schema alongside tools when tool_choice is not forced", () => {
    const out = openaiToGeminiRequest("gemini-3.7-flash", {
      messages: MESSAGES,
      response_format: jsonSchemaFormat(),
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }]
    }, false);

    expect(out.generationConfig.responseMimeType).toBe("application/json");
    expect(out.tools[0].functionDeclarations).toHaveLength(1);
  });

  it.each(["required", "any", { type: "function", function: { name: "search" } }])(
    "drops the JSON mime type when tool_choice is forced (%o)",
    (toolChoice) => {
      // Google: "Forced function calling (ANY mode) with a response mime type:
      // 'application/json' is unsupported" — 400 on the whole turn.
      const out = openaiToGeminiRequest("gemini-3.7-flash", {
        messages: MESSAGES,
        response_format: jsonSchemaFormat(),
        tool_choice: toolChoice,
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }]
      }, false);

      expect(out.generationConfig.responseMimeType).toBeUndefined();
      expect(out.generationConfig.responseSchema).toBeUndefined();
      expect(out.tools[0].functionDeclarations).toHaveLength(1);
    }
  );

  it("leaves generationConfig untouched when there is no response_format", () => {
    const out = openaiToGeminiRequest("gemini-3.7-flash", { messages: MESSAGES }, false);
    expect(out.generationConfig).toEqual({});
  });

  it("ignores response_format types it does not understand", () => {
    const out = openaiToGeminiRequest("gemini-3.7-flash", {
      messages: MESSAGES,
      response_format: { type: "text" }
    }, false);
    expect(out.generationConfig.responseMimeType).toBeUndefined();
  });

  it("carries through the Gemini CLI variant, next to thinkingConfig", () => {
    const out = openaiToGeminiCLIRequest("gemini-3.7-flash", {
      messages: MESSAGES,
      response_format: jsonSchemaFormat(),
      reasoning_effort: "high"
    }, false);

    expect(out.generationConfig.responseMimeType).toBe("application/json");
    expect(out.generationConfig.responseSchema).toBeDefined();
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });
});

describe("Responses API: response_format -> text.format", () => {
  it("maps json_schema, forwarding name, schema and strict", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.6-luna", {
      messages: MESSAGES,
      response_format: jsonSchemaFormat()
    }, true);

    expect(out.text.format).toEqual({
      type: "json_schema",
      name: "t",
      schema: SCHEMA,
      strict: true
    });
  });

  it("omits strict when the caller did not set it", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.6-luna", {
      messages: MESSAGES,
      response_format: { type: "json_schema", json_schema: { name: "t", schema: structuredClone(SCHEMA) } }
    }, true);

    expect(out.text.format.strict).toBeUndefined();
    expect(out.text.format.name).toBe("t");
  });

  it("defaults the name, which the Responses API requires and chat does not", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.6-luna", {
      messages: MESSAGES,
      response_format: { type: "json_schema", json_schema: { schema: structuredClone(SCHEMA) } }
    }, true);

    expect(out.text.format.name).toBe("response");
  });

  it("maps json_object", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.6-luna", {
      messages: MESSAGES,
      response_format: { type: "json_object" }
    }, true);

    expect(out.text.format).toEqual({ type: "json_object" });
  });

  it("sets no text field when there is no response_format", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.6-luna", { messages: MESSAGES }, true);
    expect(out.text).toBeUndefined();
  });

  it("leaves a body already in Responses shape alone", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.6-luna", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      text: { format: { type: "json_object" } }
    }, true);

    expect(out.text.format).toEqual({ type: "json_object" });
  });
});
